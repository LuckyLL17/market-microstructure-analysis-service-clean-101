import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MarketEngine } from '../src/engine.js';
import { analyzeWindow, WindowValidationError, SCAN_LIMIT } from '../src/window.js';
import { MarketEvent } from '../src/types.js';

const DAY = '2026-09-30';
const T0 = Date.parse('2026-09-30T09:30:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let seqCounter = 0;
function event(partial: Partial<MarketEvent> & { symbol: string; type: MarketEvent['type']; timestamp: string; tradingDay: string }): MarketEvent {
  seqCounter += 1;
  return { id: `X-${seqCounter}`, sequence: seqCounter, ...partial };
}
function resetSeq(start = 0) { seqCounter = start; }

function freshBookFixture(symbol: string, day = DAY) {
  const engine = new MarketEngine();
  resetSnap(engine, symbol, day, [[100, 500], [99.99, 400]], [[100.01, 300], [100.02, 500]]);
  return engine;
}
function resetSnap(engine: MarketEngine, symbol: string, day: string, bids: Array<[number, number]>, asks: Array<[number, number]>, atMs = T0, seq = 1) {
  engine.ingest({
    id: `${symbol}-SNAP`, symbol, tradingDay: day, timestamp: iso(atMs), sequence: seq, type: 'snapshot',
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
  });
}

describe('种子数据：窗口重放与实时盘口一致', () => {
  test('ALPHA 全日 event 采样的最终 as-of 指标等于实时 analytics，成交量仅统计 trade 事件', () => {
    const engine = new MarketEngine();
    const result = analyzeWindow(engine, {
      symbol: 'ALPHA',
      from: iso(T0),
      to: iso(T0 + 12_000),
      sampling: 'event',
      maxSamples: 100,
    });
    assert.equal(result.emptyWindow, false);
    assert.equal(result.eventCount, 13);
    assert.equal(result.appliedEventCount, 13);
    // 仅 type=trade 的 4 笔：40 + 76 + 112 + 148
    assert.equal(result.totalTradeVolume, 376);
    assert.equal(result.tradeCount, 4);

    const last = result.samples.at(-1)!;
    const live = engine.analytics('ALPHA');
    assert.equal(last.asOf, iso(T0 + 12_000));
    assert.equal(last.eventTriggered, true);
    assert.equal(last.appliedEventCount, 13);
    assert.equal(last.bestBid, live.bestBid);
    assert.equal(last.bestAsk, live.bestAsk);
    assert.equal(last.bidDepth, live.bidDepth);
    assert.equal(last.askDepth, live.askDepth);
    assert.equal(last.imbalance, live.imbalance);
    assert.deepEqual(last.marketBuyImpact, live.marketBuyImpact);
    assert.equal(last.liquidityScore, live.liquidityScore);
    // 重放后盘口：bid 100.01（买单 M-11 挂单后未被吃）、ask 100.02
    assert.equal(last.bestBid, 100.01);
    assert.equal(last.bestAsk, 100.02);
    assert.ok(last.cumulativeVolumeByDay[DAY] >= 376);
    assert.equal(result.duplicateCount, 0);
    assert.equal(result.gapCount, 0);
    assert.equal(result.lateCount, 0);
  });

  test('盘前基线：窗口从行情中段开始时 as-of 仍反映窗口前的事件', () => {
    const engine = new MarketEngine();
    // 09:30:09.5 位于 seq10(+10s) 之前：窗口内尚无事件，但盘前基线已重放 seq1..seq9
    const result = analyzeWindow(engine, {
      symbol: 'ALPHA',
      from: iso(T0 + 9500),
      to: iso(T0 + 13_000),
      sampling: 'points',
      points: [iso(T0 + 9500)],
    });
    const sample = result.samples[0];
    assert.equal(sample.lastEventTimestamp, iso(T0 + 9000));
    assert.equal(sample.appliedEventCount, 0, '窗口内尚未应用事件');
    assert.equal(sample.bestBid, 100, '盘前重放构建出的 best bid');
    assert.equal(sample.bestAsk, 100.02);
    assert.ok(sample.cumulativeVolume >= 116, '盘前成交已计入当日累计');
  });
});

describe('三种采样方式', () => {
  test('interval 与 event 在同一时刻的 as-of 指标完全一致', () => {
    const engine = new MarketEngine();
    const symbol = 'TST1';
    resetSnap(engine, symbol, DAY, [[100, 500]], [[100.01, 300]]);
    engine.ingest({ id: 't1', symbol, tradingDay: DAY, timestamp: iso(T0 + 1000), sequence: 2, type: 'trade', aggressorSide: 'buy', price: 100.01, quantity: 100 });
    engine.ingest({ id: 't2', symbol, tradingDay: DAY, timestamp: iso(T0 + 2000), sequence: 3, type: 'trade', aggressorSide: 'sell', price: 100, quantity: 50 });

    const byEvent = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + 3000), sampling: 'event', maxSamples: 10 });
    const byInterval = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + 3000), sampling: 'interval', intervalMs: 1000 });

    assert.equal(byInterval.samples.length, 4); // 0s,1s,2s,3s
    // T0 处快照事件落在窗口内（边界包含），故 0s 网格已应用 1 个事件
    assert.deepEqual(byInterval.samples.map(s => s.appliedEventCount), [1, 2, 3, 3]);
    assert.deepEqual(byInterval.samples.map(s => s.eventTriggered), [false, false, false, false]);

    const eventAt1s = byEvent.samples.find(s => s.asOf === iso(T0 + 1000))!;
    const gridAt1s = byInterval.samples[1];
    for (const field of ['bestBid', 'bestAsk', 'bidDepth', 'askDepth', 'imbalance', 'spread', 'liquidityScore'] as const) {
      assert.equal(gridAt1s[field], eventAt1s[field], `字段 ${field} 一致`);
    }
    assert.equal(gridAt1s.cumulativeVolume, eventAt1s.cumulativeVolume);
    // 第一笔成交 100 后，ask 一档剩余 200
    assert.equal(gridAt1s.asks[0].quantity, 200);
    // 3s 处无新事件，as-of 保持 2s 状态，增量成交为 0
    assert.equal(byInterval.samples[3].tradeVolume, 0);
    assert.equal(byInterval.samples[3].lastEventTimestamp, iso(T0 + 2000));

    // points 模式显式取点
    const byPoints = analyzeWindow(engine, {
      symbol, from: iso(T0), to: iso(T0 + 3000),
      sampling: 'points', points: [iso(T0 + 500), iso(T0 + 1500)],
    });
    assert.equal(byPoints.samples.length, 2);
    assert.equal(byPoints.samples[0].asks[0].quantity, 300);
    assert.equal(byPoints.samples[1].asks[0].quantity, 200);
  });

  test('event 模式样本数受 maxSamples 约束且顺序保留', () => {
    const engine = new MarketEngine();
    const symbol = 'TST1B';
    resetSnap(engine, symbol, DAY, [[100, 500]], [[100.01, 500]]);
    for (let i = 0; i < 20; i++) {
      engine.ingest({ id: `q${i}`, symbol, tradingDay: DAY, timestamp: iso(T0 + 1000 + i), sequence: 2 + i, type: 'trade', aggressorSide: 'buy', price: 100.01, quantity: 1 });
    }
    const result = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + 30_000), sampling: 'event', maxSamples: 5 });
    assert.equal(result.samples.length, 5);
    const times = result.samples.map(s => Date.parse(s.asOf));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });
});

describe('乱序、晚到、缺口、重复序列', () => {
  test('晚到事件按事件时间归位重放，缺口由迟到事件补全；接入侧异常仍可追溯', () => {
    const engine = new MarketEngine();
    const symbol = 'OOO';
    resetSnap(engine, symbol, DAY, [[100, 500]], [[100.01, 500]]);
    // 接入顺序：seq3 先到（造成接入侧 gap），seq2 晚到（timestamp 更早）
    engine.ingest({ id: 'e3', symbol, tradingDay: DAY, timestamp: iso(T0 + 3000), sequence: 3, type: 'trade', aggressorSide: 'buy', price: 100.01, quantity: 100 });
    const late = engine.ingest({ id: 'e2', symbol, tradingDay: DAY, timestamp: iso(T0 + 2000), sequence: 2, type: 'trade', aggressorSide: 'buy', price: 100.01, quantity: 50 });
    assert.equal(late.accepted, true);

    // 实时盘口按接入顺序：先吃 100 再吃 50 → ask 剩 350
    assert.equal(engine.book(symbol).snapshot(1).asks[0].quantity, 350);

    const result = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + 4000), sampling: 'event', maxSamples: 10 });
    // 重放顺序：seq2(qty50) → seq3(qty100)，2s 时刻 ask 应剩 450
    const at2s = result.samples.find(s => s.asOf === iso(T0 + 2000))!;
    assert.equal(at2s.asks[0].quantity, 450);
    const at3s = result.samples.find(s => s.asOf === iso(T0 + 3000))!;
    assert.equal(at3s.asks[0].quantity, 350);

    assert.equal(result.lateCount, 1);
    assert.equal(result.anomalies.filter(a => a.type === 'late_arrival').length, 1);
    // 规范化顺序下 seq1,2,3 连续，窗口重放无缺口
    assert.equal(result.gapCount, 0);
    // 接入侧曾记录 gap + 时间倒挂
    const types = result.ingestAnomalies.map(a => a.type);
    assert.ok(types.includes('sequence_gap'));
    assert.ok(types.includes('out_of_order_timestamp'));
    // 事件清单保留实际顺序并标记 late
    const e2 = result.events.find(e => e.id === 'e2')!;
    assert.equal(e2.late, true);
    assert.ok(result.warnings.some(w => w.includes('晚到')));
  });

  test('真实缺口被识别且不重放缺失序列', () => {
    const engine = new MarketEngine();
    const symbol = 'GAP';
    resetSnap(engine, symbol, DAY, [[100, 500]], [[100.01, 500]], T0, 1);
    engine.ingest({ id: 'g5', symbol, tradingDay: DAY, timestamp: iso(T0 + 1000), sequence: 5, type: 'trade', aggressorSide: 'buy', price: 100.01, quantity: 10 });
    const result = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + 2000), sampling: 'event', maxSamples: 10 });
    assert.equal(result.gapCount, 1);
    assert.equal(result.anomalies.find(a => a.type === 'sequence_gap')?.detail.missing, 3);
  });

  test('重复序列在接入侧被拒，窗口结果不重复计数/重放', () => {
    const engine = new MarketEngine();
    const symbol = 'DUP';
    resetSnap(engine, symbol, DAY, [[100, 500]], [[100.01, 500]]);
    const first = engine.ingest({ id: 'd2a', symbol, tradingDay: DAY, timestamp: iso(T0 + 1000), sequence: 2, type: 'trade', aggressorSide: 'buy', price: 100.01, quantity: 10 });
    const second = engine.ingest({ id: 'd2b', symbol, tradingDay: DAY, timestamp: iso(T0 + 1000), sequence: 2, type: 'trade', aggressorSide: 'buy', price: 100.01, quantity: 10 });
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false);
    const result = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + 2000), sampling: 'event', maxSamples: 10 });
    assert.equal(result.appliedEventCount, 2); // 快照 + 唯一 seq2
    assert.equal(result.duplicateCount, 0);
    assert.equal(result.totalTradeVolume, 10); // 第二笔被拒，未重复成交
  });

  test('crossed/locked 盘口聚合为异常', () => {
    const engine = new MarketEngine();
    const symbol = 'CRS';
    resetSnap(engine, symbol, DAY, [[100.05, 100]], [[100.01, 100]]);
    const result = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + 1000), sampling: 'interval', intervalMs: 500 });
    assert.ok(result.samples.every(s => s.crossed));
    assert.ok(result.anomalies.some(a => a.type === 'crossed_book'));
  });
});

describe('空窗口与跨交易日', () => {
  test('空窗口：event 模式无样本、interval 模式产出 as-of 基线样本', () => {
    const engine = new MarketEngine();
    const emptyEvent = analyzeWindow(engine, { symbol: 'ALPHA', from: iso(T0 + 40_000), to: iso(T0 + 50_000), sampling: 'event' });
    assert.equal(emptyEvent.emptyWindow, true);
    assert.equal(emptyEvent.samples.length, 0);
    assert.equal(emptyEvent.events.length, 0);

    const emptyInterval = analyzeWindow(engine, { symbol: 'ALPHA', from: iso(T0 + 40_000), to: iso(T0 + 42_000), sampling: 'interval', intervalMs: 1000 });
    assert.equal(emptyInterval.emptyWindow, true);
    assert.equal(emptyInterval.samples.length, 3);
    assert.ok(emptyInterval.samples.every(s => !s.eventTriggered));
    // 基线仍包含窗口前种子行情
    assert.equal(emptyInterval.samples[0].bestBid, 100.01);

    const unknown = analyzeWindow(engine, { symbol: 'GHOST', from: iso(T0 + 100_000), to: iso(T0 + 200_000), sampling: 'event' });
    assert.equal(unknown.emptyWindow, true);
    assert.equal(unknown.samples.length, 0);
  });

  test('跨交易日：序列按交易日分别判定，成交量按日分组', () => {
    const engine = new MarketEngine();
    const symbol = 'MULTI';
    const day1 = '2026-09-29';
    const day2 = '2026-09-30';
    const d1 = Date.parse(`${day1}T14:59:59.000Z`);
    const d2 = Date.parse(`${day2}T09:30:00.000Z`);
    resetSnap(engine, symbol, day1, [[10, 100]], [[10.01, 100]], d1, 1);
    engine.ingest({ id: 'd1t', symbol, tradingDay: day1, timestamp: iso(d1 + 1000), sequence: 2, type: 'trade', aggressorSide: 'buy', price: 10.01, quantity: 30 });
    resetSnap(engine, symbol, day2, [[20, 200]], [[20.01, 200]], d2, 1);
    engine.ingest({ id: 'd2t', symbol, tradingDay: day2, timestamp: iso(d2 + 1000), sequence: 2, type: 'trade', aggressorSide: 'buy', price: 20.01, quantity: 70 });

    const result = analyzeWindow(engine, { symbol, from: iso(d1), to: iso(d2 + 2000), sampling: 'event', maxSamples: 10 });
    assert.equal(result.emptyWindow, false);
    // 两天 seq 都从 1 开始，不应误报跨日缺口
    assert.equal(result.gapCount, 0);
    assert.ok(result.warnings.some(w => w.includes('跨越 2 个交易日')));
    const last = result.samples.at(-1)!;
    assert.equal(last.cumulativeVolumeByDay[day1], 30);
    assert.equal(last.cumulativeVolumeByDay[day2], 70);
    assert.equal(last.cumulativeVolume, 100);
    assert.equal(result.totalTradeVolume, 100);

    // 限定 tradingDay=day2：day1 事件仍按时间范围纳入并报 mismatch
    const filtered = analyzeWindow(engine, { symbol, tradingDay: day2, from: iso(d1), to: iso(d2 + 2000), sampling: 'event', maxSamples: 10 });
    assert.ok(filtered.anomalies.some(a => a.type === 'trading_day_mismatch' && a.tradingDay === day1));
    assert.ok(filtered.warnings.some(w => w.includes('tradingDay')));
  });

  test('仅给 tradingDay 时按 UTC 自然日展开', () => {
    const engine = new MarketEngine();
    const result = analyzeWindow(engine, { symbol: 'ALPHA', tradingDay: DAY, sampling: 'event', maxSamples: 100 });
    assert.equal(result.from, `${DAY}T00:00:00.000Z`);
    assert.equal(result.to, `${DAY}T23:59:59.999Z`);
    assert.equal(result.eventCount, 13);
  });
});

describe('参数校验与资源边界', () => {
  test('非法参数返回明确错误码', () => {
    const engine = new MarketEngine();
    assert.throws(() => analyzeWindow(engine, { symbol: '' }), (e: unknown) => e instanceof WindowValidationError && e.code === 'INVALID_SYMBOL');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', from: iso(T0) }), (e: unknown) => e instanceof WindowValidationError && e.code === 'INVALID_RANGE');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', from: iso(T0 + 1), to: iso(T0) }), (e: unknown) => e instanceof WindowValidationError && e.code === 'INVALID_RANGE');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', tradingDay: '20260930' }), (e: unknown) => e instanceof WindowValidationError && e.code === 'INVALID_TRADING_DAY');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', tradingDay: DAY, sampling: 'points', points: [] }), (e: unknown) => e instanceof WindowValidationError && e.code === 'INVALID_POINTS');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', from: iso(T0), to: iso(T0 + 1000), sampling: 'points', points: [iso(T0 + 2000)] }), (e: unknown) => e instanceof WindowValidationError && e.code === 'POINTS_OUT_OF_RANGE');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', tradingDay: DAY, sampling: 'event', maxSamples: 999999 }), (e: unknown) => e instanceof WindowValidationError && e.code === 'TOO_MANY_SAMPLES');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', tradingDay: DAY, sampling: 'interval', intervalMs: 1 }), (e: unknown) => e instanceof WindowValidationError && e.code === 'TOO_MANY_SAMPLES');
    assert.throws(() => analyzeWindow(engine, { symbol: 'ALPHA', tradingDay: DAY, depth: 0 }), (e: unknown) => e instanceof WindowValidationError && e.code === 'INVALID_DEPTH');
  });

  test('大批量事件：超限拒绝（资源边界），限内快速完成且样本受限', () => {
    const engine = new MarketEngine();
    const symbol = 'BIG';
    resetSnap(engine, symbol, DAY, [[90, 1_000_000]], [[110, 1_000_000]]);
    const N_FAST = 100_000;
    for (let i = 0; i < N_FAST; i++) {
      engine.ingest({
        id: `b${i}`, symbol, tradingDay: DAY, timestamp: iso(T0 + i), sequence: 2 + i,
        type: 'new_order', orderId: `OB-${i}`, side: i % 2 ? 'buy' : 'sell',
        price: i % 2 ? 80 : 120, quantity: 1,
      });
    }
    const started = Date.now();
    const result = analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + N_FAST), sampling: 'event', maxSamples: 500 });
    const elapsed = Date.now() - started;
    assert.equal(result.eventCount, N_FAST + 1);
    assert.equal(result.appliedEventCount, N_FAST + 1);
    assert.equal(result.samples.length, 500);
    assert.ok(result.replayDurationMs <= 5_000, `重放应在 5s 内完成，实际 ${result.replayDurationMs}ms`);
    assert.ok(elapsed <= 5_000);

    // 超过扫描上限：明确 400 类错误
    const N_OVER = SCAN_LIMIT + 10;
    for (let i = N_FAST; i < N_OVER; i++) {
      engine.ingest({
        id: `b${i}`, symbol, tradingDay: DAY, timestamp: iso(T0 + i), sequence: 2 + i,
        type: 'quote', price: 100, quantity: 1,
      });
    }
    assert.throws(
      () => analyzeWindow(engine, { symbol, from: iso(T0), to: iso(T0 + N_OVER + 1000), sampling: 'event' }),
      (e: unknown) => e instanceof WindowValidationError && e.code === 'WINDOW_TOO_LARGE',
    );
  }, 60_000);
});

describe('确定性', () => {
  test('同一窗口重复分析结果一致（除耗时字段）', () => {
    const engine = new MarketEngine();
    const body = { symbol: 'ALPHA', from: iso(T0), to: iso(T0 + 13_000), sampling: 'interval' as const, intervalMs: 2000 };
    const a = analyzeWindow(engine, body);
    const b = analyzeWindow(engine, body);
    const strip = (r: unknown) => { const { replayDurationMs: _x, ...rest } = r as Record<string, unknown>; return rest; };
    assert.deepEqual(strip(a), strip(b));
  });
});
