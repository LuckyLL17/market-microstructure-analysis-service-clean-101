import { OrderBook } from './order-book.js';
import { computeAnalytics } from './analytics-lib.js';
import { Analytics, EventType, MarketEvent, PriceLevel, Side } from './types.js';

export type SamplingMode = 'event' | 'interval' | 'points';

export type EventWindowQuery = {
  symbol: string;
  /** 单个交易日（YYYY-MM-DD）；跨日时改用 tradingDayFrom / tradingDayTo */
  tradingDay?: string;
  tradingDayFrom?: string;
  tradingDayTo?: string;
  from: string;
  to: string;
  sampling: SamplingMode;
  /** interval 模式：采样步长（毫秒），默认 1000 */
  intervalMs?: number;
  /** points 模式：等分采样点数（含两端锚点），默认 2 */
  points?: number;
  /** 盘口返回深度，默认 10，最大 50 */
  depth?: number;
  /** 样本数硬上限（资源边界），默认 5000 */
  maxSamples?: number;
  /** 窗口内允许应用的事件数硬上限（资源边界），默认 200000 */
  maxEvents?: number;
};

export type WindowAnomaly = {
  type: 'duplicate_sequence' | 'sequence_gap' | 'out_of_order_timestamp' | 'late_arrival'
    | 'crossed_book' | 'empty_book' | 'wide_spread' | 'stale_quote' | 'large_trade';
  severity: 'low' | 'medium' | 'high';
  timestamp: string;
  sequence?: number;
  eventId?: string;
  detail: Record<string, unknown>;
};

export type TradeVolume = {
  tradeCount: number;
  totalQuantity: number;
  totalNotional: number;
  buyVolume: number;
  sellVolume: number;
  /** (主买量 - 主卖量) / (主买量 + 主卖量)，无成交为 null */
  buySellImbalance: number | null;
  averageTradeSize: number | null;
  largestTrade: { eventId: string; price: number; quantity: number; aggressorSide: Side } | null;
};

export type WindowSample = {
  /** as-of 时间（event 模式为事件时间；interval/points 模式为网格时间） */
  timestamp: string;
  /** as-of 已应用事件数（含窗口前基线增量；跨日查询中为跨日累计） */
  appliedEventCount: number;
  /** 决定该 as-of 状态的最后一个事件；无前置事件时为 null */
  lastEventId: string | null;
  lastEventSequence: number | null;
  lastEventType: EventType | null;
  /** 锚点事件迟到毫秒（事件时间晚于到达时间）；无则 null */
  latenessMs: number | null;
  /** 自上一样本以来的成交统计（首样本统计窗口起点到首锚点间的成交） */
  trades: TradeVolume;
  /** 相对上一样本的盘口变化，首个样本为 null */
  changes: {
    bestBidDelta: number | null;
    bestAskDelta: number | null;
    midDelta: number | null;
    spreadDelta: number | null;
    bidDepthDelta: number;
    askDepthDelta: number;
    imbalanceDelta: number | null;
  } | null;
  anomalies: WindowAnomaly[];
  book: { bids: PriceLevel[]; asks: PriceLevel[] };
  analytics: Analytics;
};

export type WindowCompleteness = {
  eventCount: number;
  duplicateSequences: Array<{ tradingDay: string; sequence: number; eventIds: string[]; firstSeen: string }>;
  sequenceGaps: Array<{ from: number; to: number; tradingDay: string }>;
  /** 事件时间晚于到达时间（晚到） */
  lateArrivals: Array<{ tradingDay: string; eventId: string; sequence: number; timestamp: string; receivedAt: string; latenessMs: number }>;
  /** 到达顺序中事件时间戳倒退（事件时间乱序） */
  outOfOrderTimestamps: Array<{ tradingDay: string; eventId: string; sequence: number; timestamp: string; previousTimestamp: string }>;
  /** 同日同序列号不同事件，未应用的一条 */
  supersededEvents: Array<{ tradingDay: string; sequence: number; removedEventId: string; appliedEventId: string }>;
  crossedBookCount: number;
  emptyBookCount: number;
};

export type EventWindowResult = {
  symbol: string;
  tradingDays: string[];
  from: string;
  to: string;
  sampling: SamplingMode;
  intervalMs?: number;
  points?: number;
  generatedAt: string;
  empty: boolean;
  /** 窗口事件数超过 maxEvents，只应用了前 maxEvents 条 */
  truncated: boolean;
  sampleCount: number;
  /** 匹配到 symbol/交易日 的原始事件数（含重复） */
  scannedEventCount: number;
  /** 实际应用事件数（基线 + 窗口） */
  appliedEventCount: number;
  /** 窗口内完整成交量（用于与样本增量交叉核对） */
  volume: TradeVolume;
  /** 规范化后实际应用的事件顺序（保留真实事件序列） */
  eventOrder: Array<{
    id: string;
    sequence: number;
    tradingDay: string;
    timestamp: string;
    type: EventType;
    receivedAt: string;
    latenessMs: number | null;
  }>;
  completeness: WindowCompleteness;
  samples: WindowSample[];
};

const DEFAULT_MAX_SAMPLES = 5000;
const DEFAULT_MAX_EVENTS = 200_000;
const WIDE_SPREAD_BPS = 100;
const STALE_QUOTE_MS = 30_000;
const LARGE_TRADE_QTY = 1000;

function emptyVolume(): TradeVolume {
  return { tradeCount: 0, totalQuantity: 0, totalNotional: 0, buyVolume: 0, sellVolume: 0, buySellImbalance: null, averageTradeSize: null, largestTrade: null };
}

function addTrade(volume: TradeVolume, event: MarketEvent): void {
  if (event.type !== 'trade' || event.price === undefined || event.quantity === undefined) return;
  const side = event.aggressorSide ?? 'buy';
  volume.tradeCount += 1;
  volume.totalQuantity += event.quantity;
  volume.totalNotional += event.price * event.quantity;
  if (side === 'buy') volume.buyVolume += event.quantity; else volume.sellVolume += event.quantity;
  if (!volume.largestTrade || event.quantity > volume.largestTrade.quantity) {
    volume.largestTrade = { eventId: event.id, price: event.price, quantity: event.quantity, aggressorSide: side };
  }
}

function finalizeVolume(volume: TradeVolume): TradeVolume {
  return {
    ...volume,
    totalQuantity: +volume.totalQuantity.toFixed(4),
    totalNotional: +volume.totalNotional.toFixed(4),
    buyVolume: +volume.buyVolume.toFixed(4),
    sellVolume: +volume.sellVolume.toFixed(4),
    buySellImbalance: volume.buyVolume + volume.sellVolume
      ? +((volume.buyVolume - volume.sellVolume) / (volume.buyVolume + volume.sellVolume)).toFixed(4)
      : null,
    averageTradeSize: volume.tradeCount ? +(volume.totalQuantity / volume.tradeCount).toFixed(4) : null,
  };
}

/**
 * 把原始事件（可能乱序、重复、晚到、跨交易日）规范化为按
 * (timestamp, sequence, id) 的实际应用顺序；同日同序列号只保留一条。
 * 不修改输入数组。数组顺序视为到达顺序，用于时间戳倒退检测。
 */
export function canonicalize(raw: MarketEvent[]): {
  ordered: MarketEvent[];
  duplicates: WindowCompleteness['duplicateSequences'];
  gaps: WindowCompleteness['sequenceGaps'];
  outOfOrder: WindowCompleteness['outOfOrderTimestamps'];
  superseded: WindowCompleteness['supersededEvents'];
} {
  const arrivalOrder = raw;
  const outOfOrder: WindowCompleteness['outOfOrderTimestamps'] = [];
  const lastByDay = new Map<string, MarketEvent>();
  for (const event of arrivalOrder) {
    const prev = lastByDay.get(event.tradingDay);
    if (prev && event.timestamp < prev.timestamp) {
      outOfOrder.push({ tradingDay: event.tradingDay, eventId: event.id, sequence: event.sequence, timestamp: event.timestamp, previousTimestamp: prev.timestamp });
    }
    if (!prev || event.timestamp >= prev.timestamp) lastByDay.set(event.tradingDay, event);
  }

  const sorted = [...raw].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  const byDay = new Map<string, Map<number, MarketEvent>>();
  const duplicates: WindowCompleteness['duplicateSequences'] = [];
  const superseded: WindowCompleteness['supersededEvents'] = [];
  const ordered: MarketEvent[] = [];

  for (const event of sorted) {
    let dayMap = byDay.get(event.tradingDay);
    if (!dayMap) { dayMap = new Map(); byDay.set(event.tradingDay, dayMap); }
    const existing = dayMap.get(event.sequence);
    if (existing) {
      duplicates.push({
        tradingDay: event.tradingDay,
        sequence: event.sequence,
        eventIds: [...new Set([existing.id, event.id])],
        firstSeen: existing.timestamp,
      });
      if (existing.id !== event.id) {
        superseded.push({ tradingDay: event.tradingDay, sequence: event.sequence, removedEventId: event.id, appliedEventId: existing.id });
      }
      continue;
    }
    dayMap.set(event.sequence, event);
    ordered.push(event);
  }

  const gaps: WindowCompleteness['sequenceGaps'] = [];
  for (const [day, map] of byDay) {
    const sequences = [...map.keys()].sort((a, b) => a - b);
    for (let i = 1; i < sequences.length; i++) {
      if (sequences[i] > sequences[i - 1] + 1) gaps.push({ from: sequences[i - 1], to: sequences[i], tradingDay: day });
    }
  }

  return { ordered, duplicates, gaps, outOfOrder, superseded };
}

function receivedAtOf(event: MarketEvent): string {
  return event.receivedAt ?? event.timestamp;
}

function latenessOf(event: MarketEvent): number {
  // 晚到：到达时间晚于事件自身时间
  return Date.parse(receivedAtOf(event)) - Date.parse(event.timestamp);
}

function clampPositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function resolveTradingDays(query: EventWindowQuery): Set<string> {
  if (query.tradingDay) return new Set([query.tradingDay]);
  if (query.tradingDayFrom || query.tradingDayTo) {
    return enumerateDays(query.tradingDayFrom ?? query.tradingDayTo!, query.tradingDayTo ?? query.tradingDayFrom!);
  }
  // 未指定交易日时按时间范围覆盖的 UTC 自然日推导
  const fromDay = new Date(query.from).toISOString().slice(0, 10);
  const toDay = new Date(query.to).toISOString().slice(0, 10);
  return enumerateDays(fromDay, toDay);
}

function enumerateDays(fromDay: string, toDay: string): Set<string> {
  const days = new Set<string>();
  const cursor = new Date(`${fromDay}T00:00:00.000Z`);
  const end = new Date(`${toDay}T00:00:00.000Z`);
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < 400) {
    days.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return days;
}

/**
 * 基线重放起点：before 中最后一个 snapshot 之后的位置（snapshot 本身由本函数应用）；
 * 没有 snapshot 则从头重放全部前置事件。
 */
function seedBaseline(book: OrderBook, before: MarketEvent[]): number {
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i].type === 'snapshot') {
      book.apply(before[i]);
      return i + 1;
    }
  }
  return 0;
}

function buildTimeGrid(query: EventWindowQuery, fromMs: number, toMs: number, maxSamples: number): number[] {
  if (query.sampling === 'points') {
    const requested = clampPositive(query.points, 2);
    const count = Math.min(requested, maxSamples);
    if (requested === 1 || count === 1) return [toMs];
    const step = (toMs - fromMs) / (requested - 1);
    return Array.from({ length: count }, (_, i) => Math.round(fromMs + step * i));
  }
  const intervalMs = clampPositive(query.intervalMs, 1000);
  const grid: number[] = [];
  for (let t = fromMs; t <= toMs && grid.length < maxSamples; t += intervalMs) grid.push(t);
  if (grid.length && grid[grid.length - 1] !== toMs && grid.length < maxSamples) grid.push(toMs);
  return grid;
}

/** 执行事件窗口分析。events 为该 symbol 的原始事件（跨日也可），函数内部规范化。 */
export function analyzeEventWindow(events: MarketEvent[], query: EventWindowQuery): EventWindowResult {
  const days = resolveTradingDays(query);
  const maxSamples = clampPositive(query.maxSamples, DEFAULT_MAX_SAMPLES);
  const maxEvents = clampPositive(query.maxEvents, DEFAULT_MAX_EVENTS);
  const depth = query.depth && query.depth > 0 ? Math.min(query.depth, 50) : 10;

  const fromMs = Date.parse(query.from);
  const toMs = Date.parse(query.to);

  const dayScoped = events.filter(e => days.has(e.tradingDay));
  const { ordered, duplicates, gaps, outOfOrder, superseded } = canonicalize(dayScoped);

  // [from, to] 闭区间
  const inWindow = ordered.filter(e => {
    const t = Date.parse(e.timestamp);
    return t >= fromMs && t <= toMs;
  });
  const beforeWindow = ordered.filter(e => Date.parse(e.timestamp) < fromMs);
  const baselineEvent = beforeWindow.at(-1) ?? null;

  const truncated = inWindow.length > maxEvents;
  const appliedInWindow = truncated ? inWindow.slice(0, maxEvents) : inWindow;

  // 基线盘口：仅当窗口内确有事件时渲染窗口前状态；空窗口保持空盘口
  const book = new OrderBook(query.symbol);
  let baseIndex = 0;
  let appliedCount = 0;
  if (inWindow.length > 0) {
    baseIndex = seedBaseline(book, beforeWindow);
    for (let i = baseIndex; i < beforeWindow.length; i++) book.apply(beforeWindow[i]);
    // seedBaseline 已应用起点 snapshot（若有），appliedEventCount 需计入它
    appliedCount = beforeWindow.length - baseIndex + (baseIndex > 0 ? 1 : 0);
  }
  const samples: WindowSample[] = [];
  let prevAnalytics: Analytics | null = null;
  let tradesSince = emptyVolume();
  let crossedBookCount = 0;
  let emptyBookCount = 0;

  const detectAfterEvent = (event: MarketEvent, bids: PriceLevel[], asks: PriceLevel[]): WindowAnomaly[] => {
    const found: WindowAnomaly[] = [];
    if (event.type === 'trade' && event.quantity !== undefined && event.quantity >= LARGE_TRADE_QTY) {
      found.push({ type: 'large_trade', severity: 'medium', timestamp: event.timestamp, sequence: event.sequence, eventId: event.id, detail: { quantity: event.quantity, price: event.price, aggressorSide: event.aggressorSide ?? 'buy' } });
    }
    if (bids.length && asks.length) {
      if (bids[0].price >= asks[0].price) {
        found.push({ type: 'crossed_book', severity: 'high', timestamp: event.timestamp, sequence: event.sequence, eventId: event.id, detail: { bestBid: bids[0].price, bestAsk: asks[0].price } });
      } else {
        const mid = (bids[0].price + asks[0].price) / 2;
        const bps = (asks[0].price - bids[0].price) / mid * 10_000;
        if (bps >= WIDE_SPREAD_BPS) found.push({ type: 'wide_spread', severity: 'low', timestamp: event.timestamp, sequence: event.sequence, eventId: event.id, detail: { spreadBps: +bps.toFixed(2) } });
      }
    } else if (event.type !== 'snapshot') {
      found.push({ type: 'empty_book', severity: 'medium', timestamp: event.timestamp, sequence: event.sequence, eventId: event.id, detail: { bidLevels: bids.length, askLevels: asks.length } });
    }
    return found;
  };

  const emitSample = (timestamp: string, anchor: MarketEvent | null, sampleAnomalies: WindowAnomaly[]) => {
    const snap = book.snapshot(depth);
    const { bids, asks } = snap;
    if (!bids.length || !asks.length) emptyBookCount += 1;
    if (bids.length && asks.length && bids[0].price >= asks[0].price) crossedBookCount += 1;
    const analytics = computeAnalytics(query.symbol, timestamp, bids, asks);
    const changes = prevAnalytics === null ? null : {
      bestBidDelta: delta(analytics.bestBid, prevAnalytics.bestBid),
      bestAskDelta: delta(analytics.bestAsk, prevAnalytics.bestAsk),
      midDelta: delta(analytics.midPrice, prevAnalytics.midPrice),
      spreadDelta: delta(analytics.spread, prevAnalytics.spread),
      bidDepthDelta: +(analytics.bidDepth - prevAnalytics.bidDepth).toFixed(4),
      askDepthDelta: +(analytics.askDepth - prevAnalytics.askDepth).toFixed(4),
      imbalanceDelta: +(analytics.imbalance - prevAnalytics.imbalance).toFixed(4),
    };
    const lateness = anchor ? latenessOf(anchor) : 0;
    samples.push({
      timestamp,
      appliedEventCount: appliedCount,
      lastEventId: anchor?.id ?? null,
      lastEventSequence: anchor?.sequence ?? null,
      lastEventType: anchor?.type ?? null,
      latenessMs: anchor && lateness > 0 ? lateness : null,
      trades: finalizeVolume(tradesSince),
      changes,
      anomalies: sampleAnomalies,
      book: { bids, asks },
      analytics,
    });
    prevAnalytics = analytics;
    tradesSince = emptyVolume();
  };

  if (query.sampling === 'event') {
    for (const event of appliedInWindow) {
      if (samples.length >= maxSamples) break;
      book.apply(event);
      appliedCount += 1;
      addTrade(tradesSince, event);
      const { bids, asks } = book.snapshot(depth);
      emitSample(event.timestamp, event, detectAfterEvent(event, bids, asks));
    }
  } else {
    const grid = buildTimeGrid(query, fromMs, toMs, maxSamples);
    let cursor = 0;
    for (const t of grid) {
      if (samples.length >= maxSamples) break;
      while (cursor < appliedInWindow.length && Date.parse(appliedInWindow[cursor].timestamp) <= t) {
        const event = appliedInWindow[cursor];
        book.apply(event);
        appliedCount += 1;
        addTrade(tradesSince, event);
        cursor += 1;
      }
      // 空窗口不锚定窗口前事件：窗口内无数据即视为空（避免把盘口状态带给不相关的后续窗口）
      const anchor = inWindow.length ? (appliedInWindow[cursor - 1] ?? baselineEvent) : null;
      const iso = new Date(t).toISOString();
      const sampleAnomalies: WindowAnomaly[] = [];
      if (anchor) {
        const age = t - Date.parse(anchor.timestamp);
        if (age >= STALE_QUOTE_MS) {
          sampleAnomalies.push({ type: 'stale_quote', severity: 'low', timestamp: iso, sequence: anchor.sequence, eventId: anchor.id, detail: { ageMs: age } });
        }
      } else {
        sampleAnomalies.push({ type: 'empty_book', severity: 'medium', timestamp: iso, detail: { reason: 'no_event_before_sample' } });
      }
      emitSample(iso, anchor, sampleAnomalies);
    }
  }

  // 窗口总成交量
  const totalVolume = emptyVolume();
  for (const e of appliedInWindow) addTrade(totalVolume, e);

  const windowIds = new Set(appliedInWindow.map(e => e.id));
  const eventOrder = appliedInWindow.map(e => {
    const lateness = latenessOf(e);
    return {
      id: e.id, sequence: e.sequence, tradingDay: e.tradingDay, timestamp: e.timestamp,
      type: e.type, receivedAt: receivedAtOf(e), latenessMs: lateness > 0 ? lateness : null,
    };
  });

  const completeness: WindowCompleteness = {
    eventCount: inWindow.length,
    duplicateSequences: duplicates.filter(d => appliedInWindow.some(e => e.tradingDay === d.tradingDay && e.sequence === d.sequence)
      || inWindow.some((e, i) => i >= maxEvents && e.tradingDay === d.tradingDay && e.sequence === d.sequence)),
    sequenceGaps: gaps.filter(g => inWindow.some(e => e.tradingDay === g.tradingDay && e.sequence >= g.from && e.sequence <= g.to)),
    lateArrivals: canonicalLateArrivals(ordered).filter(l => windowIds.has(l.eventId)),
    outOfOrderTimestamps: outOfOrder.filter(o => windowIds.has(o.eventId)),
    supersededEvents: superseded.filter(s => inWindow.some(e => e.tradingDay === s.tradingDay && e.sequence === s.sequence)),
    crossedBookCount,
    emptyBookCount,
  };

  return {
    symbol: query.symbol,
    tradingDays: [...days].sort(),
    from: query.from,
    to: query.to,
    sampling: query.sampling,
    intervalMs: query.sampling === 'interval' ? query.intervalMs : undefined,
    points: query.sampling === 'points' ? query.points : undefined,
    generatedAt: new Date().toISOString(),
    empty: inWindow.length === 0,
    truncated,
    sampleCount: samples.length,
    scannedEventCount: dayScoped.length,
    appliedEventCount: appliedCount,
    volume: finalizeVolume(totalVolume),
    eventOrder,
    completeness,
    samples,
  };
}

function canonicalLateArrivals(ordered: MarketEvent[]): WindowCompleteness['lateArrivals'] {
  const result: WindowCompleteness['lateArrivals'] = [];
  for (const event of ordered) {
    const lateness = latenessOf(event);
    if (lateness > 0) {
      result.push({
        tradingDay: event.tradingDay, eventId: event.id, sequence: event.sequence,
        timestamp: event.timestamp, receivedAt: receivedAtOf(event), latenessMs: lateness,
      });
    }
  }
  return result;
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return +(a - b).toFixed(4);
}
