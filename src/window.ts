import { OrderBook } from './order-book.js';
import type { MarketEngine } from './engine.js';
import { computeBookAnalytics } from './analytics.js';
import {
  MarketEvent,
  WindowAnalyticsRequest,
  WindowAnalyticsResponse,
  WindowSample,
  WindowAnomaly,
  WindowEventSummary,
  PriceLevel,
} from './types.js';

/** 单次窗口重放最多处理的事件数（盘前基线 + 窗口内），超出返回 400，限制 CPU/内存边界 */
export const SCAN_LIMIT = 200_000;
/** 返回事件清单上限，超出截断 */
const EVENT_LIST_LIMIT = 10_000;
/** 样本数硬上限 */
const SAMPLE_CAP = 5_000;
/** 明细异常返回上限（聚合计数不受影响） */
const ANOMALY_LIST_CAP = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class WindowValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WindowValidationError';
  }
}

type Normalized = {
  symbol: string;
  tradingDay: string | null;
  fromMs: number;
  toMs: number;
  sampling: 'event' | 'interval' | 'points';
  maxSamples: number;
  intervalMs: number;
  points: number[];
  depth: number;
  impactQuantities: number[];
};

function dayBoundsUtc(day: string): { from: number; to: number } {
  const t = Date.parse(`${day}T00:00:00.000Z`);
  return { from: t, to: t + 86_400_000 - 1 };
}

export function normalizeRequest(input: WindowAnalyticsRequest): { req: Normalized; warnings: string[] } {
  const warnings: string[] = [];
  if (!input || typeof input.symbol !== 'string' || !input.symbol.trim()) {
    throw new WindowValidationError('INVALID_SYMBOL', 'symbol 不能为空');
  }
  const symbol = input.symbol.trim();

  if (input.tradingDay !== undefined && !DAY_RE.test(input.tradingDay)) {
    throw new WindowValidationError('INVALID_TRADING_DAY', 'tradingDay 必须为 YYYY-MM-DD');
  }
  const parseTs = (value: unknown, field: string): number => {
    if (typeof value !== 'string' || !value.trim()) throw new WindowValidationError('INVALID_TIME', `${field} 必须为 ISO 时间字符串`);
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new WindowValidationError('INVALID_TIME', `${field} 不是合法的 ISO 时间: ${value}`);
    return ms;
  };

  const sampling = input.sampling ?? 'event';
  if (!['event', 'interval', 'points'].includes(sampling)) {
    throw new WindowValidationError('INVALID_SAMPLING', 'sampling 仅支持 event / interval / points');
  }

  let points: number[] = [];
  if (sampling === 'points') {
    if (!Array.isArray(input.points) || input.points.length === 0) {
      throw new WindowValidationError('INVALID_POINTS', 'points 采样需要至少一个时间点');
    }
    points = [...new Set(input.points)].map(value => parseTs(value, 'points[]'));
    points.sort((a, b) => a - b);
    if (points.length > SAMPLE_CAP) throw new WindowValidationError('TOO_MANY_SAMPLES', `points 数量超过上限 ${SAMPLE_CAP}`);
  }

  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (input.from !== undefined) fromMs = parseTs(input.from, 'from');
  if (input.to !== undefined) toMs = parseTs(input.to, 'to');
  if ((fromMs === undefined) !== (toMs === undefined)) {
    throw new WindowValidationError('INVALID_RANGE', 'from 与 to 必须同时提供');
  }
  if (fromMs === undefined) {
    if (sampling === 'points') {
      fromMs = points[0];
      toMs = points[points.length - 1];
    } else if (input.tradingDay) {
      const bounds = dayBoundsUtc(input.tradingDay);
      fromMs = bounds.from;
      toMs = bounds.to;
    } else {
      throw new WindowValidationError('INVALID_RANGE', '必须提供 tradingDay 或 from/to 时间范围');
    }
  }
  if ((toMs as number) < (fromMs as number)) {
    throw new WindowValidationError('INVALID_RANGE', 'from 不能晚于 to');
  }

  const maxSamples = input.maxSamples ?? 500;
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) throw new WindowValidationError('INVALID_MAX_SAMPLES', 'maxSamples 必须为正整数');
  if (maxSamples > SAMPLE_CAP) throw new WindowValidationError('TOO_MANY_SAMPLES', `maxSamples 超过硬上限 ${SAMPLE_CAP}`);

  const intervalMs = input.intervalMs ?? 1000;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new WindowValidationError('INVALID_INTERVAL', 'intervalMs 必须为正整数');

  if (sampling === 'points') {
    if (points.some(ms => ms < (fromMs as number) || ms > (toMs as number))) {
      throw new WindowValidationError('POINTS_OUT_OF_RANGE', '所有 points 必须落在 [from, to] 内');
    }
  }
  if (sampling === 'interval') {
    const grid = Math.floor(((toMs as number) - (fromMs as number)) / intervalMs) + 1;
    if (grid > SAMPLE_CAP) {
      throw new WindowValidationError('TOO_MANY_SAMPLES', `间隔网格点数 ${grid} 超过上限 ${SAMPLE_CAP}，请增大 intervalMs`);
    }
  }

  const depth = input.depth ?? 10;
  if (!Number.isInteger(depth) || depth < 1 || depth > 100) throw new WindowValidationError('INVALID_DEPTH', 'depth 必须为 1..100 的整数');

  const impactQuantities = input.impactQuantities ?? [100, 500, 1000];
  if (!Array.isArray(impactQuantities) || impactQuantities.some(q => typeof q !== 'number' || q <= 0)) {
    throw new WindowValidationError('INVALID_IMPACT_QUANTITIES', 'impactQuantities 必须为正数数组');
  }

  // 显式时间范围与 tradingDay 不一致：以时间范围为准，仅告警
  if (input.tradingDay && input.from !== undefined) {
    const startDay = new Date(fromMs as number).toISOString().slice(0, 10);
    const endDay = new Date(toMs as number).toISOString().slice(0, 10);
    if (startDay !== input.tradingDay || endDay !== input.tradingDay) {
      warnings.push(`tradingDay=${input.tradingDay} 与时间范围 ${input.from} ~ ${input.to} 不一致，时间范围为准，tradingDay 仅用于事件过滤`);
    }
  }

  return {
    req: {
      symbol,
      tradingDay: input.tradingDay ?? null,
      fromMs: fromMs as number,
      toMs: toMs as number,
      sampling,
      maxSamples,
      intervalMs,
      points,
      depth,
      impactQuantities,
    },
    warnings,
  };
}

/** 均匀、确定性地从 n 个事件中挑选 k 个样本下标（中点法，天然去重且有序） */
function pickIndices(n: number, k: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor((i + 0.5) * n / k);
    if (result[result.length - 1] !== idx) result.push(idx);
  }
  return result;
}

export function analyzeWindow(engine: MarketEngine, raw: WindowAnalyticsRequest): WindowAnalyticsResponse {
  const started = Date.now();
  const { req, warnings: inputWarnings } = normalizeRequest(raw);
  const { symbol, tradingDay, fromMs, toMs } = req;
  const warnings = [...inputWarnings];

  // ---- 切分盘前基线事件与窗口事件（sameSymbol 按时间升序，早于 from 的为该 symbol 的前缀）----
  const sameSymbol = engine.sortedEvents().filter(event => event.symbol === symbol);
  let boundary = sameSymbol.length;
  const snapshotIndices: number[] = [];
  for (let i = 0; i < sameSymbol.length; i++) {
    if (Date.parse(sameSymbol[i].timestamp) < fromMs) {
      if (sameSymbol[i].type === 'snapshot') snapshotIndices.push(i);
    } else {
      boundary = i;
      break;
    }
  }
  // 基线起点：最近一次快照。跨交易日窗口还需包含各交易日最后一次快照——
  // 反向收集：从最后快照向前，每个新交易日的最后快照都纳入，保证盘口在每个交易日被正确重置。
  const preIndexSet = new Set<number>();
  const baselineDays = new Set<string>();
  for (let k = snapshotIndices.length - 1; k >= 0; k--) {
    const idx = snapshotIndices[k];
    const day = sameSymbol[idx].tradingDay;
    if (baselineDays.has(day)) continue;
    baselineDays.add(day);
    preIndexSet.add(idx);
  }
  const earliestBaselineSnapshot = preIndexSet.size ? Math.min(...preIndexSet) : 0;
  for (let i = earliestBaselineSnapshot; i < boundary; i++) preIndexSet.add(i);
  const preEvents = [...preIndexSet].sort((a, b) => a - b).map(i => sameSymbol[i]);
  const inWindowRaw = sameSymbol.slice(boundary).filter(event => Date.parse(event.timestamp) <= toMs);

  // ---- 窗口内去重（防御性：即便接入侧已拦截重复序列，重放仍以唯一序列为准）----
  const seenDuplicateInList = new Set<string>();
  const selected: MarketEvent[] = [];
  const duplicates: MarketEvent[] = [];
  for (const event of inWindowRaw) {
    const key = `${event.tradingDay}:${event.sequence}`;
    if (seenDuplicateInList.has(key)) {
      duplicates.push(event);
    } else {
      seenDuplicateInList.add(key);
      selected.push(event);
    }
  }

  if (preEvents.length + selected.length > SCAN_LIMIT) {
    throw new WindowValidationError(
      'WINDOW_TOO_LARGE',
      `窗口重放需要处理 ${preEvents.length + selected.length} 个事件，超过资源上限 ${SCAN_LIMIT}，请缩小时间范围`,
    );
  }

  // ---- 跨交易日 / tradingDay 一致性检查 ----
  const daysInWindow = new Set(selected.map(event => event.tradingDay));
  if (daysInWindow.size > 1) warnings.push(`时间范围跨越 ${daysInWindow.size} 个交易日，序列缺口按交易日分别判定`);
  const mismatchByDay = new Map<string, number>();
  if (tradingDay) {
    for (const event of selected) {
      if (event.tradingDay !== tradingDay) mismatchByDay.set(event.tradingDay, (mismatchByDay.get(event.tradingDay) ?? 0) + 1);
    }
    if (mismatchByDay.size) warnings.push(`窗口内存在 tradingDay 非 ${tradingDay} 的事件，已按时间范围纳入并标记异常`);
  }

  // ---- event 模式采样下标 ----
  const chosen = req.sampling === 'event' ? new Set(pickIndices(selected.length, Math.min(req.maxSamples, selected.length))) : null;

  // ---- 晚到判定：规范化顺序后，若存在时间更晚但接入更早（arrivalIndex 更小）的事件，则本事件为晚到。
  // 事件已按 (timestamp, sequence, arrivalIndex) 升序，反向扫描维护“严格更晚时间戳事件的最小到达序号”，O(n)。
  // 相同时间戳内按 (seq, arrival) 排序，不算晚到。 ----
  const computeLateIds = (events: MarketEvent[]): Set<string> => {
    const ids = new Set<string>();
    let minArrivalLater = Number.POSITIVE_INFINITY;
    let groupMin = Number.POSITIVE_INFINITY;
    let groupTs: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const current = events[i];
      if (current.timestamp !== groupTs) {
        minArrivalLater = Math.min(minArrivalLater, groupMin);
        groupMin = Number.POSITIVE_INFINITY;
        groupTs = current.timestamp;
      }
      groupMin = Math.min(groupMin, current.arrivalIndex ?? 0);
      if ((current.arrivalIndex ?? 0) > minArrivalLater) ids.add(current.id);
    }
    return ids;
  };
  const lateIds = computeLateIds(selected);

  // ---- interval 网格 / points 统一为 as-of 队列 ----
  const asOfQueue: number[] = [];
  if (req.sampling === 'interval') {
    for (let ms = fromMs; ms <= toMs; ms += req.intervalMs) asOfQueue.push(ms);
  } else if (req.sampling === 'points') {
    asOfQueue.push(...req.points);
  }

  // ---- 重放状态 ----
  const book = new OrderBook(symbol);
  const seenByDay = new Map<string, Set<number>>();
  const prevByDay = new Map<string, MarketEvent>();
  const dayVolume = new Map<string, number>(); // 重放已知的当日累计成交量（含盘前）

  const anomalies: WindowAnomaly[] = [];
  let anomalyOverflow = 0;
  const pushAnomaly = (anomaly: WindowAnomaly) => {
    if (anomalies.length < ANOMALY_LIST_CAP) anomalies.push(anomaly);
    else anomalyOverflow += 1;
  };

  let duplicateCount = 0;
  let gapCount = 0;
  let lateCount = 0;
  let appliedEventCount = 0;
  let windowVolume = 0;
  let windowNotional = 0;
  let windowTradeCount = 0;
  let crossedCount = 0;
  let crossedFirst: string | null = null;
  let crossedLast: string | null = null;

  const samples: WindowSample[] = [];
  let lastEvent: MarketEvent | null = null;
  // 距上个样本的增量成交
  let deltaVolume = 0;
  let deltaNotional = 0;
  let deltaTrades = 0;

  const ensureDay = (day: string): Set<number> => {
    let set = seenByDay.get(day);
    if (!set) {
      set = new Set<number>();
      seenByDay.set(day, set);
    }
    return set;
  };

  const applyEvent = (event: MarketEvent, inWindow: boolean): boolean => {
    const seen = ensureDay(event.tradingDay);
    if (seen.has(event.sequence)) return false;
    seen.add(event.sequence);
    book.apply(event);
    if (event.type === 'trade' && typeof event.quantity === 'number' && typeof event.price === 'number') {
      dayVolume.set(event.tradingDay, (dayVolume.get(event.tradingDay) ?? 0) + event.quantity);
      if (inWindow) {
        windowVolume += event.quantity;
        windowNotional += event.quantity * event.price;
        windowTradeCount += 1;
        deltaVolume += event.quantity;
        deltaNotional += event.quantity * event.price;
        deltaTrades += 1;
      }
    }
    appliedEventCount += inWindow ? 1 : 0;
    return true;
  };

  const buildSample = (asOfMs: number, eventTriggered: boolean, trigger: MarketEvent | null): void => {
    const snap = book.snapshot(req.depth);
    const bids: PriceLevel[] = snap.bids;
    const asks: PriceLevel[] = snap.asks;
    const metrics = computeBookAnalytics({
      symbol,
      timestamp: new Date(asOfMs).toISOString(),
      bids,
      asks,
      impactQuantities: req.impactQuantities,
    });
    const byDay: Record<string, number> = {};
    let cumulative = 0;
    for (const [day, qty] of dayVolume) { byDay[day] = +qty.toFixed(4); cumulative += qty; }
    const sample: WindowSample = {
      asOf: new Date(asOfMs).toISOString(),
      lastEventTimestamp: lastEvent ? lastEvent.timestamp : null,
      appliedEventCount,
      eventTriggered,
      triggerEventId: trigger?.id,
      triggerEventType: trigger?.type,
      symbol,
      bestBid: metrics.bestBid,
      bestAsk: metrics.bestAsk,
      midPrice: metrics.midPrice,
      spread: metrics.spread,
      relativeSpread: metrics.relativeSpread,
      bids,
      asks,
      bidDepth: metrics.bidDepth,
      askDepth: metrics.askDepth,
      imbalance: metrics.imbalance,
      weightedImbalance: metrics.weightedImbalance,
      marketBuyImpact: metrics.marketBuyImpact,
      marketSellImpact: metrics.marketSellImpact,
      estimatedFillProbability: metrics.estimatedFillProbability,
      liquidityScore: metrics.liquidityScore,
      tradeVolume: +deltaVolume.toFixed(4),
      tradeNotional: +deltaNotional.toFixed(4),
      tradeCount: deltaTrades,
      cumulativeVolume: +cumulative.toFixed(4),
      cumulativeVolumeByDay: byDay,
      crossed: metrics.crossed,
    };
    if (metrics.crossed) {
      crossedCount += 1;
      crossedFirst ??= sample.asOf;
      crossedLast = sample.asOf;
    }
    samples.push(sample);
    deltaVolume = 0;
    deltaNotional = 0;
    deltaTrades = 0;
  };

  // ---- 盘前基线重放（不产出窗口异常，但建立序列去重表与盘口）----
  for (const event of preEvents) {
    if (applyEvent(event, false)) {
      prevByDay.set(event.tradingDay, event);
      lastEvent = event;
    }
  }

  // ---- 窗口主重放：保留规范化后的实际事件顺序 (timestamp, sequence, arrivalIndex) ----
  let gridCursor = 0;
  for (let index = 0; index < selected.length; index++) {
    const event = selected[index];
    const eventMs = Date.parse(event.timestamp);

    // interval/points 模式：先补发位于本事件之前的 as-of 样本
    if (req.sampling !== 'event') {
      while (gridCursor < asOfQueue.length && asOfQueue[gridCursor] < eventMs) {
        buildSample(asOfQueue[gridCursor], false, lastEvent);
        gridCursor += 1;
      }
    }

    const isLate = lateIds.has(event.id);
    const prev = prevByDay.get(event.tradingDay);
    if (isLate) {
      lateCount += 1;
      pushAnomaly({
        type: 'late_arrival',
        severity: 'low',
        symbol,
        tradingDay: event.tradingDay,
        timestamp: event.timestamp,
        sequence: event.sequence,
        detail: { eventId: event.id, arrivalIndex: event.arrivalIndex },
      });
    }
    if (event.type !== 'snapshot' && prev && event.sequence > prev.sequence + 1) {
      gapCount += 1;
      pushAnomaly({
        type: 'sequence_gap',
        severity: 'high',
        symbol,
        tradingDay: event.tradingDay,
        timestamp: event.timestamp,
        sequence: event.sequence,
        detail: { eventId: event.id, previousSequence: prev.sequence, missing: event.sequence - prev.sequence - 1 },
      });
    }

    const applied = applyEvent(event, true);
    if (!applied) {
      // 与盘前/窗口内已有序列重复（接入侧漏拦时的防御）
      duplicateCount += 1;
      pushAnomaly({
        type: 'duplicate_sequence',
        severity: 'medium',
        symbol,
        tradingDay: event.tradingDay,
        timestamp: event.timestamp,
        sequence: event.sequence,
        detail: { eventId: event.id },
      });
    } else {
      prevByDay.set(event.tradingDay, event);
      lastEvent = event;
      if (req.sampling === 'event' && chosen?.has(index)) buildSample(eventMs, true, event);
    }

    // 与事件同一时刻的 as-of 点在事件应用后采样
    if (req.sampling !== 'event') {
      while (gridCursor < asOfQueue.length && asOfQueue[gridCursor] <= eventMs) {
        buildSample(asOfQueue[gridCursor], false, lastEvent);
        gridCursor += 1;
      }
    }
  }

  // 队列尾部 as-of 点（空窗口时全部样本在此产出）
  if (req.sampling !== 'event') {
    while (gridCursor < asOfQueue.length) {
      buildSample(asOfQueue[gridCursor], false, lastEvent);
      gridCursor += 1;
    }
  }

  // points 模式：独立一遍 as-of 采样。为避免重复重放，使用已重放完成的盘口无法回到过去，
  // 因此 points 在主循环中通过游标处理（见下方重放循环覆盖不到时的实现）。
  // —— points 实际处理：与 interval 同构，单独循环 ——
  // （见文件下方 pointsPass：为保持单遍重放，points 在主循环前转换为网格）

  // ---- 被丢弃的重复事件（接入侧已判重，窗口侧只统计，不重放）----
  for (const event of duplicates) {
    duplicateCount += 1;
    pushAnomaly({
      type: 'duplicate_sequence',
      severity: 'medium',
      symbol,
      tradingDay: event.tradingDay,
      timestamp: event.timestamp,
      sequence: event.sequence,
      detail: { eventId: event.id, stage: 'window_dedup' },
    });
  }

  // ---- 跨交易日 mismatch 聚合异常（每个外部交易日一条）----
  for (const [day, count] of mismatchByDay) {
    pushAnomaly({
      type: 'trading_day_mismatch',
      severity: 'low',
      symbol,
      tradingDay: day,
      detail: { expectedTradingDay: tradingDay, count },
    });
  }

  // ---- crossed/locked 盘口聚合 ----
  if (crossedCount > 0) {
    pushAnomaly({
      type: 'crossed_book',
      severity: 'high',
      symbol,
      timestamp: crossedFirst ?? undefined,
      detail: { count: crossedCount, firstSeen: crossedFirst, lastSeen: crossedLast },
    });
  }

  if (lateCount > 0) warnings.push(`检测到 ${lateCount} 个晚到事件：as-of 结果按事件时间归位重放，可能与实时接入时盘口状态不同`);
  if (anomalyOverflow > 0) warnings.push(`明细异常超过 ${ANOMALY_LIST_CAP} 条上限，已截断 ${anomalyOverflow} 条（计数仍完整）`);

  // ---- 事件清单（保留实际顺序，重复事件也列出）----
  // ---- 事件清单（保留实际顺序，重复事件也列出）----
  const allInOrder = [...inWindowRaw].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence || (a.arrivalIndex ?? 0) - (b.arrivalIndex ?? 0));
  const summaryLateIds = computeLateIds(allInOrder);
  const orderedSummaries: WindowEventSummary[] = [];
  const summarySeen = new Set<string>();
  for (const event of allInOrder) {
    const key = `${event.tradingDay}:${event.sequence}`;
    const duplicate = summarySeen.has(key);
    summarySeen.add(key);
    orderedSummaries.push({
      id: event.id,
      tradingDay: event.tradingDay,
      timestamp: event.timestamp,
      sequence: event.sequence,
      type: event.type,
      arrivalIndex: event.arrivalIndex,
      late: summaryLateIds.has(event.id),
      duplicate,
    });
  }
  const eventsTruncated = orderedSummaries.length > EVENT_LIST_LIMIT;
  if (eventsTruncated) {
    warnings.push(`事件清单超过 ${EVENT_LIST_LIMIT} 条上限，已截断（重放与统计仍基于全部事件）`);
  }

  // ---- 接入侧已记录的相关异常（同一 symbol 且时间落在窗口内）----
  const ingestAnomalies = engine.anomalies.filter(item =>
    item.symbol === symbol &&
    typeof item.timestamp === 'string' &&
    Date.parse(item.timestamp as string) >= fromMs &&
    Date.parse(item.timestamp as string) <= toMs,
  );

  const replayDurationMs = Date.now() - started;
  const totalAnomalyCount = duplicateCount + gapCount + lateCount + mismatchByDay.size + (crossedCount > 0 ? 1 : 0);

  return {
    symbol,
    tradingDay,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    sampling: req.sampling,
    samples,
    events: orderedSummaries.slice(0, EVENT_LIST_LIMIT),
    eventCount: orderedSummaries.length,
    eventsTruncated,
    appliedEventCount,
    duplicateCount,
    gapCount,
    lateCount,
    anomalyCount: totalAnomalyCount,
    anomalies,
    ingestAnomalies,
    totalTradeVolume: +windowVolume.toFixed(4),
    totalTradeNotional: +windowNotional.toFixed(4),
    tradeCount: windowTradeCount,
    emptyWindow: selected.length === 0,
    warnings,
    scanLimit: SCAN_LIMIT,
    replayDurationMs,
  };
}
