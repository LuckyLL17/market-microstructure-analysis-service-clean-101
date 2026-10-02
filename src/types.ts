export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type EventType = 'snapshot' | 'new_order' | 'cancel_order' | 'trade' | 'quote';

export type MarketEvent = {
  id: string;
  symbol: string;
  tradingDay: string;
  timestamp: string;
  sequence: number;
  type: EventType;
  /** 接入时分配的单调到达序号，用于识别晚到事件，不参与状态重放 */
  arrivalIndex?: number;
  orderId?: string;
  side?: Side;
  price?: number;
  quantity?: number;
  aggressorSide?: Side;
  bids?: PriceLevel[];
  asks?: PriceLevel[];
};

export type PriceLevel = { price: number; quantity: number };
export type BookOrder = { id: string; side: Side; price: number; quantity: number; remaining: number; sequence: number; owner?: string; type?: OrderType };
export type Fill = { orderId: string; symbol: string; side: Side; price: number; quantity: number; timestamp: string; liquidity: 'maker' | 'taker'; fee: number; strategyId?: string };
export type Analytics = {
  symbol: string;
  timestamp: string;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  relativeSpread: number | null;
  bidDepth: number;
  askDepth: number;
  imbalance: number;
  weightedImbalance: number;
  marketBuyImpact: Array<{ quantity: number; averagePrice: number | null; slippageBps: number | null; filled: number }>;
  marketSellImpact: Array<{ quantity: number; averagePrice: number | null; slippageBps: number | null; filled: number }>;
  estimatedFillProbability: { buy: number; sell: number };
  liquidityScore: number;
};
export type RiskDecision = { allowed: boolean; code?: string; message?: string; rule?: string };

// ---- 事件窗口分析 ----

export type WindowSamplingMode = 'event' | 'interval' | 'points';

export type WindowAnalyticsRequest = {
  symbol: string;
  /** 单个交易日（YYYY-MM-DD）；与 from/to 同时提供但不一致时按显式时间范围处理并给出告警 */
  tradingDay?: string;
  /** ISO 时间，包含 */
  from?: string;
  /** ISO 时间，包含 */
  to?: string;
  /** 采样方式：event=按事件，interval=等间隔 as-of，points=指定时间点 as-of */
  sampling?: WindowSamplingMode;
  /** event 模式：最多采样数（均匀抽样事件），默认 500 */
  maxSamples?: number;
  /** interval 模式：网格间隔毫秒，默认 1000 */
  intervalMs?: number;
  /** points 模式：显式 ISO 时间点 */
  points?: string[];
  /** 盘口深度，默认 10 */
  depth?: number;
  /** 冲击成本测算数量，默认 [100, 500, 1000] */
  impactQuantities?: number[];
};

export type WindowAnomaly = {
  type: 'duplicate_sequence' | 'sequence_gap' | 'late_arrival' | 'crossed_book' | 'trading_day_mismatch';
  severity: 'low' | 'medium' | 'high';
  symbol: string;
  tradingDay?: string;
  timestamp?: string;
  sequence?: number;
  detail: Record<string, unknown>;
};

export type WindowSample = {
  /** as-of 时间：event 模式为事件时间，interval/points 模式为网格点/指定点 */
  asOf: string;
  /** 该样本前最近一次事件的时间（无则为 null） */
  lastEventTimestamp: string | null;
  /** 截至 asOf 已应用的窗口内事件数 */
  appliedEventCount: number;
  /** 该样本是否由真实事件触发（false=区间/点采样的 as-of 快照） */
  eventTriggered: boolean;
  triggerEventId?: string;
  triggerEventType?: EventType;
  symbol: string;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  relativeSpread: number | null;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bidDepth: number;
  askDepth: number;
  imbalance: number;
  weightedImbalance: number;
  marketBuyImpact: Array<{ quantity: number; averagePrice: number | null; slippageBps: number | null; filled: number }>;
  marketSellImpact: Array<{ quantity: number; averagePrice: number | null; slippageBps: number | null; filled: number }>;
  estimatedFillProbability: { buy: number; sell: number };
  liquidityScore: number;
  /** 自上个样本起成交量（event 模式为该事件成交量） */
  tradeVolume: number;
  /** 自上个样本起成交额 */
  tradeNotional: number;
  /** 自上个样本起成交笔数 */
  tradeCount: number;
  /** 截至 asOf 窗口范围内累计成交量 */
  cumulativeVolume: number;
  /** 截至 asOf 各交易日累计成交量 */
  cumulativeVolumeByDay: Record<string, number>;
  /** 买一价 >= 卖一价（crossed/locked） */
  crossed: boolean;
};

export type WindowEventSummary = {
  id: string;
  tradingDay: string;
  timestamp: string;
  sequence: number;
  type: EventType;
  arrivalIndex?: number;
  late: boolean;
  duplicate: boolean;
};

export type WindowAnalyticsResponse = {
  symbol: string;
  tradingDay: string | null;
  from: string;
  to: string;
  sampling: WindowSamplingMode;
  samples: WindowSample[];
  events: WindowEventSummary[];
  eventCount: number;
  eventsTruncated: boolean;
  appliedEventCount: number;
  duplicateCount: number;
  gapCount: number;
  lateCount: number;
  anomalyCount: number;
  anomalies: WindowAnomaly[];
  ingestAnomalies: Array<Record<string, unknown>>;
  totalTradeVolume: number;
  totalTradeNotional: number;
  tradeCount: number;
  emptyWindow: boolean;
  warnings: string[];
  scanLimit: number;
  replayDurationMs: number;
};
