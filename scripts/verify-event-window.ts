/* eslint-disable no-console */
import { performance } from 'node:perf_hooks';
import { MarketEngine } from '../src/engine.js';
import { OrderBook } from '../src/order-book.js';
import { analyzeEventWindow } from '../src/event-window.js';
import { MarketEvent } from '../src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`, detail ?? ''); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, { actual, expected });
}
function section(name: string): void { console.log(`\n${name}`); }

const iso = (day: string, hms: string, ms = 0) => new Date(`${day}T${hms}.${String(ms).padStart(3, '0')}Z`).toISOString();
const DAY = '2026-09-30';

function independentReplay(events: MarketEvent[], symbol: string, depth = 10) {
  // 与 analyzeEventWindow 相同的规范化逻辑（独立实现，用于交叉核对）
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const book = new OrderBook(symbol);
  const unique: MarketEvent[] = [];
  for (const e of sorted) {
    const k = `${e.tradingDay}:${e.sequence}`;
    if (seen.has(k)) continue;
    seen.add(k); unique.push(e);
  }
  return (atIso: string) => {
    while (unique.length && unique[0].timestamp <= atIso) book.apply(unique.shift()!);
    return book.snapshot(depth);
  };
}

// ---------- 1. 种子数据 + event 采样与独立重放一致 ----------
section('1. 种子数据：event 采样、as-of 盘口、成交量与独立重放一致');
{
  const engine = new MarketEngine();
  const result = engine.eventWindow({
    symbol: 'ALPHA', tradingDay: DAY,
    from: iso(DAY, '09:29:00'), to: iso(DAY, '09:30:12'),
    sampling: 'event', depth: 10,
  });
  eq('样本数 = 窗口内 13 个事件（snapshot+12）', result.sampleCount, 13);
  eq('eventOrder 保留 13 个事件', result.eventOrder.length, 13);
  check('eventOrder 按时间/序列号升序',
    result.eventOrder.every((e, i) => i === 0 || e.timestamp >= result.eventOrder[i - 1].timestamp));
  eq('窗口成交笔数 4（seq 2,5,8,11）', result.volume.tradeCount, 4);
  eq('窗口成交总量 376', result.volume.totalQuantity, 376);
  eq('买卖量之和 = 376', result.volume.buyVolume + result.volume.sellVolume, 376);
  // trades: i=0,3,6,9 → seq 2,5,8,11, qty 40,76,112,148
  // aggressor: i%2? buy i=0 sell(40), i=3 buy(76), i=6 sell(112), i=9 buy(148)
  eq('主买量 224 (76+148)', result.volume.buyVolume, 224);
  eq('主卖量 152 (40+112)', result.volume.sellVolume, 152);
  eq('最大成交 148 @100.01', result.volume.largestTrade, { eventId: 'E-11', price: 100.01, quantity: 148, aggressorSide: 'buy' as const });

  const replay = independentReplay(engine.events.filter(e => e.symbol === 'ALPHA'), 'ALPHA', 10);
  let mismatch = 0;
  for (const sample of result.samples) {
    const ref = replay(sample.timestamp);
    if (JSON.stringify(ref.bids) !== JSON.stringify(sample.book.bids) || JSON.stringify(ref.asks) !== JSON.stringify(sample.book.asks)) mismatch += 1;
  }
  eq('每个 as-of 盘口与独立重放完全一致（mismatch=0）', mismatch, 0);
  const last = result.samples.at(-1)!;
  eq('末样本 bestBid/bestAsk（按撮合规则重算）', [last.analytics.bestBid, last.analytics.bestAsk], [100.01, 100.02]);
  check('首样本 changes 为 null', result.samples[0].changes === null);
  check('后续样本 changes 非 null', result.samples.slice(1).every(s => s.changes !== null));
  // 与现有快照分析口径一致（末事件后实时盘口即窗口末盘口）
  const live = engine.analytics('ALPHA');
  eq('窗口末指标与现有快照分析完全一致', last.analytics, live);
}

// ---------- 2. interval 采样：增量成交量合计 = 窗口总量 ----------
section('2. interval 采样：as-of 锚点正确，增量成交合计 = 窗口总量');
{
  const engine = new MarketEngine();
  const result = engine.eventWindow({
    symbol: 'ALPHA', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '09:30:10'),
    sampling: 'interval', intervalMs: 2000, depth: 5,
  });
  // 网格: 00,02,04,06,08,10
  eq('网格样本数 6', result.sampleCount, 6);
  const qtyPerSample = result.samples.map(s => s.trades.totalQuantity);
  // 事件在每秒末：02 前应用 seq2,3（trade qty40 在 01s）；样本 trades 是“自上一样本”
  // 00→无, 02→seq2,3(trade40), 04→seq4,5(trade76@04? seq5 timestamp 04:00 含), 06→seq6,7, 08→seq8,9(112), 10→seq10,11(148)
  eq('每 2s 增量成交量', qtyPerSample, [0, 40, 76, 0, 112, 148]);
  eq('增量合计 = 窗口总量 376 (40+76+112+148)', qtyPerSample.reduce((a, b) => a + b, 0), 376);
  eq('窗口总量字段一致', result.volume.totalQuantity, 376);
  // 00:00 锚点是 seq1 snapshot（闭区间，timestamp 等于 from）
  eq('首样本锚点 E-1', result.samples[0].lastEventId, 'E-1');
  eq('02s 样本 appliedEventCount=3 (seq1-3)', result.samples[1].appliedEventCount, 3);
  eq('深度被限制为 5 档', result.samples[0].book.bids.length <= 5, true);
}

// ---------- 3. points 采样 ----------
section('3. points 采样：等分网格含两端');
{
  const engine = new MarketEngine();
  const result = engine.eventWindow({
    symbol: 'ALPHA', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '09:30:12'),
    sampling: 'points', points: 3,
  });
  eq('3 个点', result.sampleCount, 3);
  eq('时间网格 00/06/12', result.samples.map(s => s.timestamp), [iso(DAY, '09:30:00'), iso(DAY, '09:30:06'), iso(DAY, '09:30:12')]);
  eq('终点 appliedEventCount=13', result.samples[2].appliedEventCount, 13);
}

// ---------- 4. 乱序事件（到达顺序与事件时间不一致） ----------
section('4. 乱序到达：实际事件顺序保留，时间戳倒退被记录');
{
  const events: MarketEvent[] = [
    { id: 'A1', symbol: 'BETA', tradingDay: DAY, timestamp: iso(DAY, '09:30:00'), receivedAt: iso(DAY, '09:30:00'), sequence: 1, type: 'snapshot', bids: [{ price: 10, quantity: 100 }], asks: [{ price: 10.05, quantity: 100 }] },
    // seq3 先到（正常时间戳 02）
    { id: 'A3', symbol: 'BETA', tradingDay: DAY, timestamp: iso(DAY, '09:30:02'), receivedAt: iso(DAY, '09:30:02'), sequence: 3, type: 'trade', aggressorSide: 'buy', price: 10.05, quantity: 10 },
  ];
  // seq2 晚到：事件时间 01，但到达时间 03（迟到 2000ms），且造成缺口后补齐
  events.push({ id: 'A2', symbol: 'BETA', tradingDay: DAY, timestamp: iso(DAY, '09:30:01'), receivedAt: iso(DAY, '09:30:03'), sequence: 2, type: 'trade', aggressorSide: 'sell', price: 10, quantity: 5 });

  const result = analyzeEventWindow(events, {
    symbol: 'BETA', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '09:30:05'), sampling: 'event',
  });
  eq('event 模式按事件时间排序：A1,A2,A3', result.eventOrder.map(e => e.id), ['A1', 'A2', 'A3']);
  eq('晚到事件 A2 latenessMs=2000', result.completeness.lateArrivals.map(l => l.eventId), ['A2']);
  eq('A2 迟到毫秒', result.completeness.lateArrivals[0].latenessMs, 2000);
  // 到达顺序 A1,A3,A2 中 A2 时间戳倒退
  eq('时间戳倒退记录 A2', result.completeness.outOfOrderTimestamps.map(o => o.eventId), ['A2']);
  eq('样本顺序同样按事件时间', result.samples.map(s => s.lastEventId), ['A1', 'A2', 'A3']);
  eq('窗口总量 15（A2=5 + A3=10）', result.volume.totalQuantity, 15);
  eq('as-of A2 时刻已应用事件数 2', result.samples[1].appliedEventCount, 2);
  // live 引擎侧：按到达顺序应用，A3 先于 A2 应用于实时盘口；两者都被记录
  const engine = new MarketEngine();
  const batch = engine.ingestMany(events);
  eq('批量接入 3 条全部 accepted', [batch.accepted, batch.rejected], [3, 0]);
  check('引擎记录了 late_arrival 异常', engine.anomalies.some(a => a.type === 'late_arrival'));
}

// ---------- 5. 重复序列（完全重复 + 同序列不同 id） ----------
section('5. 重复序列：去重、冲突保留、引擎拒收');
{
  const events: MarketEvent[] = [
    { id: 'B1', symbol: 'GAMMA', tradingDay: DAY, timestamp: iso(DAY, '09:30:00'), receivedAt: iso(DAY, '09:30:00'), sequence: 1, type: 'snapshot', bids: [{ price: 20, quantity: 100 }], asks: [{ price: 20.1, quantity: 100 }] },
    { id: 'B2', symbol: 'GAMMA', tradingDay: DAY, timestamp: iso(DAY, '09:30:01'), receivedAt: iso(DAY, '09:30:01'), sequence: 2, type: 'new_order', orderId: 'O1', side: 'buy', price: 20, quantity: 50 },
    // 完全重复（重发）
    { id: 'B2', symbol: 'GAMMA', tradingDay: DAY, timestamp: iso(DAY, '09:30:01'), receivedAt: iso(DAY, '09:30:02'), sequence: 2, type: 'new_order', orderId: 'O1', side: 'buy', price: 20, quantity: 50 },
    // 同序列号不同 id（冲突）：规范序中 B2 时间更早，保留 B2，B2X 被替换
    { id: 'B2X', symbol: 'GAMMA', tradingDay: DAY, timestamp: iso(DAY, '09:30:01'), receivedAt: iso(DAY, '09:30:03'), sequence: 2, type: 'cancel_order', orderId: 'O1' },
  ];
  const result = analyzeEventWindow(events, {
    symbol: 'GAMMA', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '09:30:05'), sampling: 'event',
  });
  eq('规范序只应用 B1,B2', result.eventOrder.map(e => e.id), ['B1', 'B2']);
  eq('重复记录 2 条（seq2）', result.completeness.duplicateSequences.length, 2);
  eq('冲突替换记录 B2X 未应用', result.completeness.supersededEvents.map(s => s.removedEventId), ['B2X']);
  // 买一档数量应为 100(snapshot) + 50(B2) = 150；若错误应用 cancel 则只剩 100
  eq('as-of 末态买一量 150（未错误应用撤单）', result.samples.at(-1)!.book.bids[0].quantity, 150);

  const engine = new MarketEngine();
  const r = engine.ingestMany(events);
  eq('引擎 1,2 号 accepted；3,4 号 rejected', r.results.map(x => x.accepted), [true, true, false, false]);
  eq('引擎去重后事件总数 2（GAMMA）', engine.events.filter(e => e.symbol === 'GAMMA').length, 2);
}

// ---------- 6. 缺口检测 ----------
section('6. 序列号缺口');
{
  const events: MarketEvent[] = [
    { id: 'C1', symbol: 'DELTA', tradingDay: DAY, timestamp: iso(DAY, '09:30:00'), receivedAt: iso(DAY, '09:30:00'), sequence: 1, type: 'snapshot', bids: [{ price: 5, quantity: 10 }], asks: [{ price: 5.02, quantity: 10 }] },
    { id: 'C4', symbol: 'DELTA', tradingDay: DAY, timestamp: iso(DAY, '09:30:01'), receivedAt: iso(DAY, '09:30:01'), sequence: 4, type: 'trade', aggressorSide: 'buy', price: 5.02, quantity: 2 },
  ];
  const result = analyzeEventWindow(events, {
    symbol: 'DELTA', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '09:30:05'), sampling: 'event',
  });
  eq('缺口 1→4', result.completeness.sequenceGaps, [{ from: 1, to: 4, tradingDay: DAY }]);
  const engine = new MarketEngine();
  engine.ingestMany(events);
  check('引擎记录 sequence_gap 高严重度', engine.anomalies.some(a => a.type === 'sequence_gap' && a.severity === 'high'));
}

// ---------- 7. 空窗口 ----------
section('7. 空窗口：无事件、无 symbol');
{
  const engine = new MarketEngine();
  const result = engine.eventWindow({
    symbol: 'ALPHA', tradingDay: DAY,
    from: iso(DAY, '20:00:00'), to: iso(DAY, '20:10:00'), sampling: 'event',
  });
  eq('empty=true', result.empty, true);
  eq('event 模式 0 样本', result.sampleCount, 0);
  eq('成交量归零', result.volume.tradeCount, 0);

  const interval = engine.eventWindow({
    symbol: 'ALPHA', tradingDay: DAY,
    from: iso(DAY, '20:00:00'), to: iso(DAY, '20:00:04'), sampling: 'interval', intervalMs: 2000,
  });
  eq('interval 空窗口仍产出 3 个网格点', interval.sampleCount, 3);
  eq('网格点无锚点', interval.samples.every(s => s.lastEventId === null), true);
  check('网格点报 empty_book 异常', interval.samples.every(s => s.anomalies.some(a => a.type === 'empty_book')));
  eq('空窗口盘口为空', [interval.samples[0].book.bids.length, interval.samples[0].book.asks.length], [0, 0]);

  const unknownSymbol = engine.eventWindow({
    symbol: 'NOT-LISTED',
    from: iso(DAY, '09:00:00'), to: iso(DAY, '10:00:00'), sampling: 'points', points: 2,
  });
  eq('未知 symbol empty=true', unknownSymbol.empty, true);
  eq('未知 symbol 按时间范围推导交易日', unknownSymbol.tradingDays, [DAY]);
}

// ---------- 8. 跨交易日查询 ----------
section('8. 跨交易日：两日序列各自独立，窗口跨日聚合');
{
  const engine = new MarketEngine();
  const d1 = '2026-09-29', d2 = '2026-09-30';
  const mk = (day: string, seq: number, hms: string): MarketEvent => ({
    id: `${day}-${seq}`, symbol: 'MULTI', tradingDay: day, timestamp: iso(day, hms), receivedAt: iso(day, hms),
    sequence: seq, type: seq === 1 ? 'snapshot' : 'trade',
    bids: seq === 1 ? [{ price: 30, quantity: 100 }] : undefined,
    asks: seq === 1 ? [{ price: 30.1, quantity: 100 }] : undefined,
    aggressorSide: 'buy', price: 30.1, quantity: seq * 10,
  });
  // 两日序列号都从 1 开始，且 3→5 都有缺口
  engine.ingestMany([mk(d1, 1, '09:30:00'), mk(d1, 3, '09:30:01'), mk(d1, 5, '09:30:02')]);
  engine.ingestMany([mk(d2, 1, '09:30:00'), mk(d2, 3, '09:30:01'), mk(d2, 5, '09:30:02')]);
  const result = engine.eventWindow({
    symbol: 'MULTI', tradingDayFrom: d1, tradingDayTo: d2,
    from: iso(d1, '09:00:00'), to: iso(d2, '10:00:00'), sampling: 'event',
  });
  eq('覆盖两个交易日', result.tradingDays, [d1, d2]);
  eq('跨日共 6 个事件', result.eventOrder.length, 6);
  eq('eventOrder 时间跨日单调', result.eventOrder.every((e, i) => i === 0 || e.timestamp >= result.eventOrder[i - 1].timestamp), true);
  // 同序列号不同交易日不算重复
  eq('跨日无重复误报', result.completeness.duplicateSequences.length, 0);
  // 缺口按交易日独立计：每日 1→3, 3→5 各两个
  eq('缺口按交易日独立（4 个）', result.completeness.sequenceGaps.length, 4);
  // 引擎侧 live 盘口不应因跨日重置而误报缺口
  check('引擎无跨日 sequence_gap 误报（MULTI）',
    engine.anomalies.filter(a => a.symbol === 'MULTI' && a.type === 'sequence_gap').length === 4);
  // 跨日窗口内第二日 snapshot 必须重建盘口（snapshot 清档），末态仍有量
  eq('末态买一档仍在（snapshot 重建生效）', result.samples.at(-1)!.book.bids[0].quantity, 100);
}

// ---------- 9. 大批量事件：资源边界与性能 ----------
section('9. 大批量：120k 事件性能与 maxSamples/maxEvents 边界');
{
  const engine = new MarketEngine();
  const N = 120_000;
  const batch: MarketEvent[] = [];
  const start = Date.parse(iso(DAY, '09:30:00'));
  for (let i = 0; i < N; i++) {
    const t = new Date(start + i).toISOString();
    const isSnap = i === 0;
    batch.push({
      id: `H${i}`, symbol: 'HUGE', tradingDay: DAY, timestamp: t, receivedAt: t, sequence: i + 1,
      type: isSnap ? 'snapshot' : (i % 10 === 0 ? 'trade' : 'new_order'),
      bids: isSnap ? Array.from({ length: 10 }, (_, k) => ({ price: 100 - k * 0.01, quantity: 500 })) : undefined,
      asks: isSnap ? Array.from({ length: 10 }, (_, k) => ({ price: 100.01 + k * 0.01, quantity: 500 })) : undefined,
      orderId: `HO${i}`, side: i % 2 ? 'buy' : 'sell',
      price: i % 2 ? 100.01 : 99.99, quantity: 10,
      aggressorSide: 'buy',
    });
  }
  const t0 = performance.now();
  const ingest = engine.ingestMany(batch);
  const t1 = performance.now();
  eq('批量接入全部 accepted', ingest.accepted, N);
  eq('批量接入 0 rejected', ingest.rejected, 0);
  check(`120k 接入耗时 < 5s（实际 ${(t1 - t0).toFixed(0)}ms）`, t1 - t0 < 5000);

  // 再重放 60k 重复事件，全部拒收，且不破坏已有状态
  const dup = batch.slice(0, 60_000);
  const t2 = performance.now();
  const dupResult = engine.ingestMany(dup);
  const t3 = performance.now();
  eq('60k 重复全部 rejected', dupResult.rejected, 60_000);
  eq('拒收后事件总数仍为 N', engine.events.filter(e => e.symbol === 'HUGE').length, N);
  check(`60k 去重耗时 < 2s（实际 ${(t3 - t2).toFixed(0)}ms）`, t3 - t2 < 2000);

  // event 模式 + maxSamples=100：只产 100 样本，但 appliedEventCount 仍为 100
  const capped = engine.eventWindow({
    symbol: 'HUGE', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '23:59:59'),
    sampling: 'event', maxSamples: 100,
  });
  eq('maxSamples 截断样本数为 100', capped.sampleCount, 100);

  // interval + maxEvents=50000：窗口扫描 120k，仅应用 50k，truncated=true
  const maxEv = engine.eventWindow({
    symbol: 'HUGE', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '23:59:59'),
    sampling: 'interval', intervalMs: 60_000, maxEvents: 50_000,
  });
  eq('maxEvents 截断标记 truncated', maxEv.truncated, true);
  eq('eventOrder 只含应用的 50k', maxEv.eventOrder.length, 50_000);
  eq('scannedEventCount=120k', maxEv.scannedEventCount, N);
  check('网格样本数有界（<=5000 默认）', maxEv.sampleCount <= 5000);

  // 全量 event 窗口必须能跑通并保持有界（120k 样本允许，因为显式无上限时仍受默认 maxSamples=5000）
  const full = engine.eventWindow({
    symbol: 'HUGE', tradingDay: DAY,
    from: iso(DAY, '09:30:00'), to: iso(DAY, '23:59:59'), sampling: 'event', maxSamples: 200_000,
  });
  eq('显式放宽后样本数 = 120k', full.sampleCount, N);
  eq('全窗口成交笔数 = 11999 (i%10==0, i=10..119990)', full.volume.tradeCount, 11_999);
}

// ---------- 10. 窗口前 snapshot 基线 ----------
section('10. 窗口前 snapshot 作为 as-of 基线');
{
  const events: MarketEvent[] = [
    { id: 'S0', symbol: 'EPS', tradingDay: DAY, timestamp: iso(DAY, '09:00:00'), receivedAt: iso(DAY, '09:00:00'), sequence: 1, type: 'snapshot', bids: [{ price: 7, quantity: 77 }], asks: [{ price: 7.05, quantity: 88 }] },
    { id: 'S2', symbol: 'EPS', tradingDay: DAY, timestamp: iso(DAY, '09:05:00'), receivedAt: iso(DAY, '09:05:00'), sequence: 2, type: 'new_order', orderId: 'X2', side: 'buy', price: 7, quantity: 22 },
    { id: 'S3', symbol: 'EPS', tradingDay: DAY, timestamp: iso(DAY, '10:05:00'), receivedAt: iso(DAY, '10:05:00'), sequence: 3, type: 'new_order', orderId: 'X3', side: 'sell', price: 7.05, quantity: 33 },
  ];
  const result = analyzeEventWindow(events, {
    symbol: 'EPS', tradingDay: DAY,
    from: iso(DAY, '10:00:00'), to: iso(DAY, '10:10:00'), sampling: 'event',
  });
  // 窗口内只有 S3，但基线必须包含 S0 snapshot + S2
  eq('窗口内 1 个事件', result.eventOrder.map(e => e.id), ['S3']);
  eq('基线+窗口 appliedEventCount=3', result.samples[0].appliedEventCount, 3);
  eq('as-of 买一量 = 77+22=99', result.samples[0].book.bids[0].quantity, 99);
  eq('as-of 卖一量 = 88+33=121', result.samples[0].book.asks[0].quantity, 121);
}

// ---------- 汇总 ----------
section('结果');
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
