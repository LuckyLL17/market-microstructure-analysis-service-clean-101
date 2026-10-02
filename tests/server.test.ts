import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, engine } from '../src/server.js';

after(async () => { await app.close(); });

describe('POST /api/analytics/window', () => {
  test('与现有快照分析并存：同一服务同时提供当前 analytics 与窗口分析', async () => {
    const snapshot = await app.inject({ method: 'GET', url: '/api/analytics/ALPHA' });
    assert.equal(snapshot.statusCode, 200);
    const live = snapshot.json();

    const res = await app.inject({
      method: 'POST',
      url: '/api/analytics/window',
      payload: {
        symbol: 'ALPHA',
        from: '2026-09-30T09:30:00.000Z',
        to: '2026-09-30T09:30:12.000Z',
        sampling: 'event',
        maxSamples: 50,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.symbol, 'ALPHA');
    assert.equal(body.eventCount, 13);
    assert.equal(body.samples.at(-1).bestBid, live.bestBid);
    assert.equal(body.samples.at(-1).askDepth, live.askDepth);
    assert.equal(body.emptyWindow, false);
  });

  test('参数错误返回 400 与结构化错误码', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analytics/window',
      payload: { symbol: 'ALPHA', from: '2026-09-30T10:00:00.000Z' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_RANGE');
  });

  test('tradingDay 简写按自然日返回（种子数据）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analytics/window',
      payload: { symbol: 'ALPHA', tradingDay: '2026-09-30', sampling: 'interval', intervalMs: 43_200_000 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.from, '2026-09-30T00:00:00.000Z');
    assert.equal(body.to, '2026-09-30T23:59:59.999Z');
    assert.equal(body.samples.length, 2); // 00:00 与 12:00
  });

  test('接入乱序事件后窗口 API 标记晚到并按事件时间归位', async () => {
    const base = Date.parse('2026-10-01T09:30:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    await app.inject({
      method: 'POST', url: '/api/market-data/events',
      payload: { id: 'W-SNAP', symbol: 'WXYZ', tradingDay: '2026-10-01', timestamp: iso(base), sequence: 1, type: 'snapshot', bids: [{ price: 50, quantity: 200 }], asks: [{ price: 50.01, quantity: 200 }] },
    });
    await app.inject({
      method: 'POST', url: '/api/market-data/events',
      payload: { id: 'W-3', symbol: 'WXYZ', tradingDay: '2026-10-01', timestamp: iso(base + 3000), sequence: 3, type: 'trade', aggressorSide: 'buy', price: 50.01, quantity: 40 },
    });
    await app.inject({
      method: 'POST', url: '/api/market-data/events',
      payload: { id: 'W-2', symbol: 'WXYZ', tradingDay: '2026-10-01', timestamp: iso(base + 2000), sequence: 2, type: 'trade', aggressorSide: 'buy', price: 50.01, quantity: 10 },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/analytics/window',
      payload: { symbol: 'WXYZ', from: iso(base), to: iso(base + 4000), sampling: 'points', points: [iso(base + 2500)] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.lateCount, 1);
    // 2.5s as-of：仅 seq2（10 手）已成交，ask 剩 190
    assert.equal(body.samples[0].asks[0].quantity, 190);
    assert.equal(body.samples[0].cumulativeVolume, 10);
    assert.ok(body.ingestAnomalies.some((a: { type: string }) => a.type === 'out_of_order_timestamp'));
    void engine;
  });
});
