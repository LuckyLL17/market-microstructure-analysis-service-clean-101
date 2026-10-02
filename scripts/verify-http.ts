/* eslint-disable no-console */
import { buildApp } from '../src/app.js';
import { FastifyInstance } from 'fastify';
import { MarketEngine } from '../src/engine.js';
import { MarketEvent } from '../src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`, detail ?? ''); }
}
function section(name: string): void { console.log(`\n${name}`); }

const DAY = '2026-09-30';
const iso = (hms: string) => new Date(`${DAY}T${hms}.000Z`).toISOString();

const app: FastifyInstance = buildApp(new MarketEngine(), false);
await app.ready();

section('H1. 现有快照接口与新事件窗口接口并存');
{
  const health = await app.inject({ method: 'GET', url: '/api/health' });
  check('health 200', health.statusCode === 200, health.body);
  check('版本 0.2.0', health.json().version === '0.2.0');

  const analytics = await app.inject({ method: 'GET', url: '/api/analytics/ALPHA' });
  check('快照分析 200', analytics.statusCode === 200);
  check('快照分析仍有 spread/imbalance/impact', ['spread', 'imbalance', 'marketBuyImpact'].every(k => k in analytics.json()));

  const orderbook = await app.inject({ method: 'GET', url: '/api/orderbook/ALPHA' });
  check('盘口快照接口仍可用', orderbook.statusCode === 200 && Array.isArray(orderbook.json().bids));
}

section('H2. GET 事件窗口（查询参数）');
{
  const qs = new URLSearchParams({
    tradingDay: DAY, from: iso('09:29:00'), to: iso('09:30:12'), sampling: 'event', depth: '5',
  });
  const res = await app.inject({ method: 'GET', url: `/api/analytics/ALPHA/event-window?${qs}` });
  check('GET 200', res.statusCode === 200, res.body);
  const body = res.json();
  check('13 个事件样本', body.sampleCount === 13, body.sampleCount);
  check('返回 as-of 盘口/价差/深度/失衡/冲击成本/成交量',
    body.samples[0].book.bids.length && body.samples.at(-1).analytics.spread !== null
    && typeof body.samples[0].analytics.bidDepth === 'number'
    && Array.isArray(body.samples[0].analytics.marketBuyImpact)
    && typeof body.volume.totalQuantity === 'number');
  check('含完整性诊断', typeof body.completeness === 'object' && Array.isArray(body.completeness.sequenceGaps));
  check('保留实际事件顺序', body.eventOrder[0].id === 'E-1' && body.eventOrder.at(-1).id === 'E-13');
}

section('H3. POST 事件窗口（interval + points 参数）');
{
  const res = await app.inject({
    method: 'POST', url: '/api/analytics/ALPHA/event-window',
    payload: { tradingDay: DAY, from: iso('09:30:00'), to: iso('09:30:10'), sampling: 'interval', intervalMs: 5000 },
  });
  check('POST interval 200', res.statusCode === 200, res.body);
  const body = res.json();
  check('00,05,10 三个网格点', body.sampleCount === 3, body.sampleCount);
  check('intervalMs 回显', body.intervalMs === 5000);

  const points = await app.inject({
    method: 'POST', url: '/api/analytics/ALPHA/event-window',
    payload: { tradingDay: DAY, from: iso('09:30:00'), to: iso('09:30:12'), sampling: 'points', points: 4 },
  });
  check('POST points 200，4 点', points.statusCode === 200 && points.json().sampleCount === 4, points.body);
}

section('H4. 参数校验');
{
  const badSampling = await app.inject({
    method: 'GET',
    url: `/api/analytics/ALPHA/event-window?tradingDay=${DAY}&from=${encodeURIComponent(iso('09:30:00'))}&to=${encodeURIComponent(iso('09:30:10'))}&sampling=bogus`,
  });
  check('非法 sampling 400', badSampling.statusCode === 400 && badSampling.json().error === 'invalid_sampling');

  const badRange = await app.inject({
    method: 'POST', url: '/api/analytics/ALPHA/event-window',
    payload: { tradingDay: DAY, from: iso('09:30:10'), to: iso('09:30:00'), sampling: 'event' },
  });
  check('to<from 400', badRange.statusCode === 400 && badRange.json().error === 'invalid_range');

  const missing = await app.inject({ method: 'POST', url: '/api/analytics/ALPHA/event-window', payload: { sampling: 'event' } });
  check('缺少 from/to 400', missing.statusCode === 400 && missing.json().error === 'invalid_range');

  const badInterval = await app.inject({
    method: 'POST', url: '/api/analytics/ALPHA/event-window',
    payload: { tradingDay: DAY, from: iso('09:30:00'), to: iso('09:30:10'), sampling: 'interval', intervalMs: -1 },
  });
  check('intervalMs<=0 400', badInterval.statusCode === 400 && badInterval.json().error === 'invalid_interval');
}

section('H5. 批量事件接入 + 乱序/重复/晚到在窗口结果中可见');
{
  const events: MarketEvent[] = [
    { id: 'W1', symbol: 'OMEGA', tradingDay: DAY, timestamp: iso('11:00:00'), receivedAt: iso('11:00:00'), sequence: 1, type: 'snapshot', bids: [{ price: 50, quantity: 200 }], asks: [{ price: 50.1, quantity: 200 }] },
    { id: 'W4', symbol: 'OMEGA', tradingDay: DAY, timestamp: iso('11:00:02'), receivedAt: iso('11:00:02'), sequence: 4, type: 'trade', aggressorSide: 'buy', price: 50.1, quantity: 20 },
    { id: 'W2', symbol: 'OMEGA', tradingDay: DAY, timestamp: iso('11:00:01'), receivedAt: iso('11:00:05'), sequence: 2, type: 'trade', aggressorSide: 'sell', price: 50, quantity: 8 },
  ];
  const batch = await app.inject({ method: 'POST', url: '/api/market-data/events/batch', payload: { events } });
  check('批量接入 200, accepted=3', batch.statusCode === 200 && batch.json().accepted === 3, batch.body);

  // 再发重复（单条接口）
  const dup = await app.inject({ method: 'POST', url: '/api/market-data/events', payload: events[2] });
  check('重复序列单条接口 accepted=false', dup.statusCode === 200 && dup.json().accepted === false);

  const res = await app.inject({
    method: 'POST', url: '/api/analytics/OMEGA/event-window',
    payload: { tradingDay: DAY, from: iso('11:00:00'), to: iso('11:00:10'), sampling: 'event' },
  });
  const body = res.json();
  check('乱序事件按事件时间还原 W1,W2,W4', body.eventOrder.map((e: { id: string }) => e.id).join(',') === 'W1,W2,W4');
  check('W2 晚到 4000ms', body.completeness.lateArrivals[0]?.eventId === 'W2' && body.completeness.lateArrivals[0]?.latenessMs === 4000);
  check('缺口 2→4（seq3 缺失）', body.completeness.sequenceGaps.some((g: { from: number; to: number }) => g.from === 2 && g.to === 4));
  check('成交量 28', body.volume.totalQuantity === 28);
  check('样本 anomalies 字段存在', Array.isArray(body.samples[0].anomalies));
}

section('H6. 跨交易日 POST 查询');
{
  const events: MarketEvent[] = [
    { id: 'X1', symbol: 'XSEC', tradingDay: '2026-09-29', timestamp: '2026-09-29T15:00:00.000Z', receivedAt: '2026-09-29T15:00:00.000Z', sequence: 1, type: 'snapshot', bids: [{ price: 9, quantity: 50 }], asks: [{ price: 9.1, quantity: 50 }] },
    { id: 'X2', symbol: 'XSEC', tradingDay: '2026-10-01', timestamp: '2026-10-01T09:00:00.000Z', receivedAt: '2026-10-01T09:00:00.000Z', sequence: 1, type: 'snapshot', bids: [{ price: 9.2, quantity: 60 }], asks: [{ price: 9.3, quantity: 60 }] },
  ];
  await app.inject({ method: 'POST', url: '/api/market-data/events/batch', payload: events });
  const res = await app.inject({
    method: 'POST', url: '/api/analytics/XSEC/event-window',
    payload: { tradingDayFrom: '2026-09-29', tradingDayTo: '2026-10-01', from: '2026-09-29T00:00:00.000Z', to: '2026-10-01T23:59:59.000Z', sampling: 'event' },
  });
  const body = res.json();
  check('跨日 200', res.statusCode === 200, res.body);
  check('覆盖 3 个交易日筛选范围', body.tradingDays.length === 3);
  check('两日同序列号 1 不算重复', body.completeness.duplicateSequences.length === 0);
  check('末样本盘口为第二日 snapshot（9.2/9.3）', body.samples.at(-1).book.bids[0].price === 9.2 && body.samples.at(-1).book.asks[0].price === 9.3);
}

section('H7. 空窗口 HTTP 语义');
{
  const res = await app.inject({
    method: 'GET',
    url: `/api/analytics/ALPHA/event-window?tradingDay=${DAY}&from=${encodeURIComponent(iso('20:00:00'))}&to=${encodeURIComponent(iso('20:00:02'))}&sampling=interval&intervalMs=1000`,
  });
  const body = res.json();
  check('空窗口 200 + empty=true', res.statusCode === 200 && body.empty === true);
  check('3 个网格点、盘口为空、无锚点', body.sampleCount === 3 && body.samples.every((s: { lastEventId: string | null; book: { bids: unknown[]; asks: unknown[] } }) => s.lastEventId === null && s.book.bids.length === 0 && s.book.asks.length === 0));
}

await app.close();
section('结果');
console.log(`通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
