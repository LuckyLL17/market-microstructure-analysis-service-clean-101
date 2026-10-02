import { Analytics, PriceLevel, Side } from './types.js';

/**
 * 由盘口档位纯函数计算全套微观结构指标。
 * 现有快照分析与事件窗口分析共用同一口径，避免两处实现漂移。
 * 调用方负责给出 as-of 时刻的盘口与最后事件时间戳。
 */
export function computeAnalytics(
  symbol: string,
  timestamp: string,
  bids: PriceLevel[],
  asks: PriceLevel[],
): Analytics {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const bidDepth = bids.reduce((sum, l) => sum + l.quantity, 0);
  const askDepth = asks.reduce((sum, l) => sum + l.quantity, 0);
  const impact = (side: Side, requested: number) => {
    const levels = side === 'buy' ? asks : bids;
    let left = requested, notional = 0, filled = 0;
    for (const level of levels) {
      const take = Math.min(left, level.quantity);
      notional += take * level.price;
      filled += take;
      left -= take;
      if (!left) break;
    }
    const averagePrice = filled ? notional / filled : null;
    const reference = side === 'buy' ? bestAsk : bestBid;
    return {
      quantity: requested,
      averagePrice: averagePrice ? +averagePrice.toFixed(4) : null,
      slippageBps: averagePrice !== null && reference !== null
        ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2)
        : null,
      filled: +filled.toFixed(4),
    };
  };
  const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
  const topBidQty = bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0);
  const topAskQty = asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0);
  const weightedImbalance = bids.length && asks.length && topBidQty + topAskQty
    ? (topBidQty - topAskQty) / (topBidQty + topAskQty)
    : 0;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  return {
    symbol,
    timestamp,
    bestBid,
    bestAsk,
    midPrice: mid,
    spread,
    relativeSpread: mid !== null && spread !== null ? spread / mid : null,
    bidDepth,
    askDepth,
    imbalance: +imbalance.toFixed(4),
    weightedImbalance: +weightedImbalance.toFixed(4),
    marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)),
    marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)),
    estimatedFillProbability: {
      buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3),
      sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3),
    },
    liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2),
  };
}
