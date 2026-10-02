import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { MarketEngine } from './engine.js';
import { OrderBook } from './order-book.js';
import { EventWindowQuery, SamplingMode } from './event-window.js';
import { MarketEvent } from './types.js';

type ReplaySession = { id: string; symbol: string; tradingDay: string; cursor: number; status: string; speed: number; eventCount: number; lastEvent?: MarketEvent; book: OrderBook };

const SAMPLING_MODES: SamplingMode[] = ['event', 'interval', 'points'];

export function buildApp(engine: MarketEngine = new MarketEngine(), logger: boolean | object = true): FastifyInstance {
  const app = Fastify({ logger });
  const replaySessions = new Map<string, ReplaySession>();

  app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ status: 'ok', service: 'market-microstructure-analysis-service', version: '0.2.0' }));
  app.get('/api/instruments', async () => [{ symbol: 'ALPHA', tradingDay: '2026-09-30', tickSize: .01, lotSize: 1, currency: 'USD', status: 'replay_ready' }]);

  app.post('/api/market-data/events', async request => engine.ingest(request.body as MarketEvent));
  app.post('/api/market-data/events/batch', async request => {
    const body = request.body as { events?: MarketEvent[] } | MarketEvent[];
    const list = Array.isArray(body) ? body : body?.events;
    if (!Array.isArray(list)) return { error: 'invalid_body', message: 'body 需为事件数组或 { events: [...] }' };
    return engine.ingestMany(list);
  });

  app.get('/api/orderbook/:symbol', async request => { const { symbol } = request.params as { symbol: string }; return { symbol, ...engine.book(symbol).snapshot(20), stats: engine.book(symbol).getStats() }; });
  app.get('/api/analytics/:symbol', async request => { const { symbol } = request.params as { symbol: string }; return engine.analytics(symbol); });

  // 事件窗口分析（GET，查询参数；与快照分析并存）
  app.get('/api/analytics/:symbol/event-window', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const q = request.query as Record<string, string | undefined>;
    const parsed = parseWindowQuery(symbol, q);
    if ('error' in parsed) { reply.code(400); return parsed; }
    return engine.eventWindow(parsed);
  });

  // 事件窗口分析（POST，JSON body，适合长 ISO 时间与复杂参数）
  app.post('/api/analytics/:symbol/event-window', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const body = (request.body ?? {}) as Partial<EventWindowQuery>;
    const parsed = parseWindowQuery(symbol, body as Record<string, unknown>);
    if ('error' in parsed) { reply.code(400); return parsed; }
    return engine.eventWindow(parsed);
  });

  app.post('/api/replay/sessions', async request => { const body = (request.body ?? {}) as { symbol?: string; tradingDay?: string; speed?: number }; const id = `REP-${replaySessions.size + 1}`; const events = engine.events.filter(event => event.symbol === (body.symbol ?? 'ALPHA') && event.tradingDay === (body.tradingDay ?? '2026-09-30')); const session: ReplaySession = { id, symbol: body.symbol ?? 'ALPHA', tradingDay: body.tradingDay ?? '2026-09-30', cursor: 0, status: 'ready', speed: body.speed ?? 1, eventCount: events.length, book: new OrderBook(body.symbol ?? 'ALPHA') }; replaySessions.set(id, session); return { id: session.id, symbol: session.symbol, tradingDay: session.tradingDay, cursor: session.cursor, status: session.status, speed: session.speed, eventCount: session.eventCount, nextEvent: events[0], book: session.book.snapshot(20) }; });
  app.get('/api/replay/sessions/:id', async request => { const session = replaySessions.get((request.params as { id: string }).id); if (!session) return { error: 'session_not_found' }; const events = engine.events.filter(event => event.symbol === session.symbol && event.tradingDay === session.tradingDay); return { id: session.id, symbol: session.symbol, tradingDay: session.tradingDay, cursor: session.cursor, status: session.status, speed: session.speed, eventCount: session.eventCount, progress: session.eventCount ? +(session.cursor / session.eventCount * 100).toFixed(2) : 100, currentEvent: events[session.cursor - 1], nextEvent: events[session.cursor], book: session.book.snapshot(20) }; });
  app.post('/api/replay/sessions/:id/step', async request => { const session = replaySessions.get((request.params as { id: string }).id); if (!session) return { error: 'session_not_found' }; const events = engine.events.filter(event => event.symbol === session.symbol && event.tradingDay === session.tradingDay); const event = events[session.cursor]; if (!event) { session.status = 'completed'; return { ...session, done: true }; } session.cursor += 1; session.book.apply(event); session.lastEvent = event; session.status = session.cursor >= events.length ? 'completed' : 'paused'; return { id: session.id, symbol: session.symbol, cursor: session.cursor, status: session.status, event, done: session.status === 'completed', book: session.book.snapshot(20) }; });
  app.post('/api/replay/sessions/:id/run', async request => { const session = replaySessions.get((request.params as { id: string }).id); if (!session) return { error: 'session_not_found' }; const body = (request.body ?? {}) as { steps?: number }; const events = engine.events.filter(event => event.symbol === session.symbol && event.tradingDay === session.tradingDay); const steps = Math.min(body.steps ?? events.length, events.length - session.cursor); for (const event of events.slice(session.cursor, session.cursor + Math.max(0, steps))) session.book.apply(event); session.cursor += Math.max(0, steps); session.status = session.cursor >= events.length ? 'completed' : 'paused'; session.lastEvent = events[session.cursor - 1]; return { id: session.id, symbol: session.symbol, cursor: session.cursor, status: session.status, processed: steps, done: session.status === 'completed', book: session.book.snapshot(20) }; });

  app.post('/api/sandbox/orders', async request => engine.submitOrder(request.body as { strategyId: string; symbol: string; side: 'buy' | 'sell'; orderType: 'limit' | 'market'; price?: number; quantity: number }));
  app.post('/api/sandbox/cancel', async request => { const body = request.body as { strategyId: string; orderId: string }; return { cancelled: engine.cancel(body.strategyId, body.orderId) }; });
  app.get('/api/sandbox/strategies/:strategyId/performance', async request => engine.performance((request.params as { strategyId: string }).strategyId));
  app.get('/api/sandbox/strategies/:strategyId/events', async request => { const strategyId = (request.params as { strategyId: string }).strategyId; return { orders: engine.anomalies.filter(item => item.detail && (item.detail as { strategyId?: string }).strategyId === strategyId), fills: engine.fills }; });
  app.get('/api/anomalies', async () => engine.anomalies);
  app.get('/api/metrics', async request => { const { symbol = 'ALPHA' } = request.query as { symbol?: string }; return { analytics: engine.analytics(symbol), eventCount: engine.events.length, fillCount: engine.fills.length, anomalyCount: engine.anomalies.length, bookStats: engine.book(symbol).getStats() }; });

  return app;
}

function parseWindowQuery(symbol: string, q: Record<string, unknown>): EventWindowQuery | { error: string; message: string } {
  const str = (key: string) => (q[key] === undefined || q[key] === null ? undefined : String(q[key]));
  const num = (key: string) => {
    const v = q[key];
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const sampling = (str('sampling') ?? 'event') as SamplingMode;
  if (!SAMPLING_MODES.includes(sampling)) return { error: 'invalid_sampling', message: `sampling 必须为 ${SAMPLING_MODES.join('/')}` };
  const from = str('from');
  const to = str('to');
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { error: 'invalid_range', message: 'from/to 必须为合法 ISO 时间且必填' };
  }
  if (Date.parse(to) < Date.parse(from)) return { error: 'invalid_range', message: 'to 不得早于 from' };
  if (sampling === 'interval') {
    const intervalMs = num('intervalMs') ?? 1000;
    if (intervalMs <= 0) return { error: 'invalid_interval', message: 'intervalMs 必须为正整数' };
  }
  if (sampling === 'points') {
    const points = num('points') ?? 2;
    if (points <= 0) return { error: 'invalid_points', message: 'points 必须为正整数' };
  }
  return {
    symbol,
    tradingDay: str('tradingDay'),
    tradingDayFrom: str('tradingDayFrom'),
    tradingDayTo: str('tradingDayTo'),
    from,
    to,
    sampling,
    intervalMs: num('intervalMs'),
    points: num('points'),
    depth: num('depth'),
    maxSamples: num('maxSamples'),
    maxEvents: num('maxEvents'),
  };
}
