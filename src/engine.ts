import { OrderBook } from './order-book.js';
import { Account, checkRisk } from './risk.js';
import { computeBookAnalytics } from './analytics.js';
import { Analytics, BookOrder, Fill, MarketEvent, Side } from './types.js';

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  /** 按接入（到达）顺序保存，arrivalIndex 标识实际事件顺序；需要时间序视图请用 sortedEvents() */
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  private readonly seenSequences = new Set<string>();
  private readonly lastBySymbolDay = new Map<string, MarketEvent>();
  private sortedView: MarketEvent[] | null = null;
  private arrivalCounter = 0;

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }

  /** 规范化事件顺序：(timestamp, sequence, arrivalIndex)。惰性排序，大批量接入后只排一次 */
  sortedEvents(): readonly MarketEvent[] {
    if (!this.sortedView) {
      this.sortedView = [...this.events].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence || (a.arrivalIndex ?? 0) - (b.arrivalIndex ?? 0));
    }
    return this.sortedView;
  }

  ingest(event: MarketEvent): { accepted: boolean; anomaly?: Record<string, unknown> } {
    // 序列按 (symbol, tradingDay) 编号，跨交易日允许序列重新计数
    const key = `${event.symbol}:${event.tradingDay}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const previous = this.lastBySymbolDay.get(`${event.symbol}:${event.tradingDay}`);
    if (previous && event.sequence > previous.sequence + 1) this.recordAnomaly('sequence_gap', event, 'high');
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium');
    event.arrivalIndex = this.arrivalCounter++;
    this.seenSequences.add(key);
    this.events.push(event);
    this.lastBySymbolDay.set(`${event.symbol}:${event.tradingDay}`, event);
    this.sortedView = null;
    this.book(event.symbol).apply(event);
    return { accepted: true };
  }
  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10);
    const { crossed: _crossed, ...metrics } = computeBookAnalytics({ symbol, timestamp: snapshot.timestamp, bids: snapshot.bids, asks: snapshot.asks });
    return metrics;
  }
  submitOrder(input: { strategyId: string; symbol: string; side: Side; orderType: 'limit' | 'market'; price?: number; quantity: number }): { accepted: boolean; risk: ReturnType<typeof checkRisk>; fills: Fill[]; orderId: string } {
    const analytics = this.analytics(input.symbol); const account = this.account(input.strategyId); const price = input.price ?? (input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0); const now = Date.now(); const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now }); const orderId = `SIM-${this.fills.length + 1}`; if (!risk.allowed) { this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'medium', { strategyId: input.strategyId, rule: risk.rule, code: risk.code }); return { accepted: false, risk, fills: [], orderId }; } account.ordersInWindow.push(now); const order = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: this.events.length + 1, owner: input.strategyId, type: input.orderType } as BookOrder & { type: 'limit' | 'market' }; const fills = this.book(input.symbol).execute(order, new Date().toISOString()); this.fills.push(...fills); this.applyFills(account, fills); if (order.remaining > 0 && input.orderType === 'market') this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'high', { remaining: order.remaining }); return { accepted: true, risk, fills, orderId };
  }
  cancel(strategyId: string, orderId: string): boolean { const account = this.account(strategyId); account.cancelInWindow.push(Date.now()); for (const book of this.books.values()) if (book.cancel(orderId)) return true; return false; }
  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: 1_000_000, equity: 1_000_000, position: {}, ordersInWindow: [], cancelInWindow: [], peakEquity: 1_000_000, maxDrawdown: .15 }; this.accounts.set(strategyId, account); } return account; }
  performance(strategyId: string) { const account = this.account(strategyId); const fills = this.fills.filter(fill => fill.orderId.startsWith('SIM-')); const byStrategy = fills.filter(fill => fill.strategyId === strategyId); const gross = byStrategy.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0); return { strategyId, account, metrics: { fillCount: byStrategy.length, tradedNotional: +byStrategy.reduce((s, f) => s + f.price * f.quantity, 0).toFixed(2), grossCashFlow: +gross.toFixed(2), fees: +byStrategy.reduce((s, f) => s + f.fee, 0).toFixed(2), netPnl: +(gross - byStrategy.reduce((s, f) => s + f.fee, 0)).toFixed(2), exposure: Object.entries(account.position).map(([symbol, quantity]) => ({ symbol, quantity })) } }; }
  private applyFills(account: Account, fills: Fill[]): void { for (const fill of fills) { const delta = fill.side === 'buy' ? fill.quantity : -fill.quantity; account.position[fill.symbol] = (account.position[fill.symbol] ?? 0) + delta; account.cash += fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee; } account.equity = account.cash; account.peakEquity = Math.max(account.peakEquity, account.equity); }
  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: now.toISOString(), sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: new Date(now.getTime() + (i + 1) * 1000).toISOString(), sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); }
}
