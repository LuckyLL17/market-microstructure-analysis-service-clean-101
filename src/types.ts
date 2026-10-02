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
  orderId?: string;
  side?: Side;
  price?: number;
  quantity?: number;
  aggressorSide?: Side;
  bids?: PriceLevel[];
  asks?: PriceLevel[];
  /** 事件到达服务的实际时间（晚到事件判定用）；缺省取接入时刻 */
  receivedAt?: string;
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
