import { OrderBook } from './order-book.js';
import { computeAnalytics } from './analytics-lib.js';
import { analyzeEventWindow, EventWindowQuery, EventWindowResult } from './event-window.js';
import { Account, checkRisk } from './risk.js';
import { Analytics, BookOrder, Fill, MarketEvent, Side } from './types.js';

type IngestResult = { accepted: boolean; anomaly?: Record<string, unknown> };

export class MarketEngine {
  readonly books = new Map<string, OrderBook>();
  readonly events: MarketEvent[] = [];
  readonly fills: Fill[] = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  readonly accounts = new Map<string, Account>();
  private readonly seenSequences = new Set<string>();
  /** 每个 symbol+tradingDay 最近一条“按到达顺序”的事件（乱序/缺口判定，不受存储排序影响） */
  private readonly lastIngested = new Map<string, MarketEvent>();

  constructor() { this.seed(); }
  book(symbol: string): OrderBook { let book = this.books.get(symbol); if (!book) { book = new OrderBook(symbol); this.books.set(symbol, book); } return book; }

  ingest(event: MarketEvent): IngestResult {
    const result = this.accept(event);
    // 存储按规范序（事件时间、序列号）排序，live 盘口按到达顺序应用，二者独立
    this.sortEvents();
    return result;
  }

  /** 批量接入：保留调用方给定的到达顺序，逐条应用到 live 盘口，只做一次排序。 */
  ingestMany(input: MarketEvent[]): { received: number; accepted: number; rejected: number; results: IngestResult[]; anomalies: Array<Record<string, unknown>> } {
    const before = this.anomalies.length;
    const results = input.map(event => this.accept(event));
    this.sortEvents();
    return {
      received: input.length,
      accepted: results.filter(r => r.accepted).length,
      rejected: results.filter(r => !r.accepted).length,
      results,
      anomalies: this.anomalies.slice(before),
    };
  }

  private accept(event: MarketEvent): IngestResult {
    const key = `${event.symbol}:${event.tradingDay}:${event.sequence}`;
    if (this.seenSequences.has(key)) return { accepted: false, anomaly: this.recordAnomaly('duplicate_sequence', event, 'medium') };
    const dayKey = `${event.symbol}:${event.tradingDay}`;
    const previous = this.lastIngested.get(dayKey);
    if (previous && event.sequence > previous.sequence + 1) {
      this.recordAnomaly('sequence_gap', event, 'high', { expected: previous.sequence + 1, previousSequence: previous.sequence });
    }
    if (previous && event.timestamp < previous.timestamp) this.recordAnomaly('out_of_order_timestamp', event, 'medium', { previousTimestamp: previous.timestamp });
    const stored: MarketEvent = { ...event, receivedAt: event.receivedAt ?? new Date().toISOString() };
    const lateness = Date.parse(stored.receivedAt!) - Date.parse(stored.timestamp);
    if (Number.isFinite(lateness) && lateness > 0) {
      this.recordAnomaly('late_arrival', stored, 'low', { receivedAt: stored.receivedAt, latenessMs: lateness });
    }
    this.seenSequences.add(key);
    this.lastIngested.set(dayKey, stored);
    this.events.push(stored);
    this.book(event.symbol).apply(event);
    return { accepted: true };
  }

  private sortEvents(): void {
    this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  }

  /** 事件窗口分析：基于该 symbol 的原始事件（含乱序/重复/晚到），由分析器规范化后重放。 */
  eventWindow(query: EventWindowQuery): EventWindowResult {
    return analyzeEventWindow(this.events.filter(e => e.symbol === query.symbol), query);
  }

  analytics(symbol: string): Analytics {
    const snapshot = this.book(symbol).snapshot(10);
    return computeAnalytics(symbol, snapshot.timestamp, snapshot.bids, snapshot.asks);
  }

  submitOrder(input: { strategyId: string; symbol: string; side: Side; orderType: 'limit' | 'market'; price?: number; quantity: number }): { accepted: boolean; risk: ReturnType<typeof checkRisk>; fills: Fill[]; orderId: string } {
    const analytics = this.analytics(input.symbol); const account = this.account(input.strategyId); const price = input.price ?? (input.side === 'buy' ? analytics.bestAsk ?? 0 : analytics.bestBid ?? 0); const now = Date.now(); const risk = checkRisk({ ...input, price, bestBid: analytics.bestBid, bestAsk: analytics.bestAsk, account, now }); const orderId = `SIM-${this.fills.length + 1}`; if (!risk.allowed) { this.recordAnomaly('risk_rejection', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'medium', { strategyId: input.strategyId, rule: risk.rule, code: risk.code }); return { accepted: false, risk, fills: [], orderId }; } account.ordersInWindow.push(now); const order = { id: orderId, side: input.side, price, quantity: input.quantity, remaining: input.quantity, sequence: this.events.length + 1, owner: input.strategyId, type: input.orderType } as BookOrder & { type: 'limit' | 'market' }; const fills = this.book(input.symbol).execute(order, new Date().toISOString()); this.fills.push(...fills); this.applyFills(account, fills); if (order.remaining > 0 && input.orderType === 'market') this.recordAnomaly('unfilled_market_order', { id: orderId, symbol: input.symbol, timestamp: new Date().toISOString(), sequence: 0 }, 'high', { remaining: order.remaining }); return { accepted: true, risk, fills, orderId };
  }
  cancel(strategyId: string, orderId: string): boolean { const account = this.account(strategyId); account.cancelInWindow.push(Date.now()); for (const book of this.books.values()) if (book.cancel(orderId)) return true; return false; }
  account(strategyId: string): Account { let account = this.accounts.get(strategyId); if (!account) { account = { strategyId, cash: 1_000_000, equity: 1_000_000, position: {}, ordersInWindow: [], cancelInWindow: [], peakEquity: 1_000_000, maxDrawdown: .15 }; this.accounts.set(strategyId, account); } return account; }
  performance(strategyId: string) { const account = this.account(strategyId); const fills = this.fills.filter(fill => fill.orderId.startsWith('SIM-')); const byStrategy = fills.filter(fill => fill.strategyId === strategyId); const gross = byStrategy.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.price * fill.quantity : -fill.price * fill.quantity), 0); return { strategyId, account, metrics: { fillCount: byStrategy.length, tradedNotional: +byStrategy.reduce((s, f) => s + f.price * f.quantity, 0).toFixed(2), grossCashFlow: +gross.toFixed(2), fees: +byStrategy.reduce((s, f) => s + f.fee, 0).toFixed(2), netPnl: +(gross - byStrategy.reduce((s, f) => s + f.fee, 0)).toFixed(2), exposure: Object.entries(account.position).map(([symbol, quantity]) => ({ symbol, quantity })) } }; }
  private applyFills(account: Account, fills: Fill[]): void { for (const fill of fills) { const delta = fill.side === 'buy' ? fill.quantity : -fill.quantity; account.position[fill.symbol] = (account.position[fill.symbol] ?? 0) + delta; account.cash += fill.side === 'buy' ? -(fill.price * fill.quantity + fill.fee) : fill.price * fill.quantity - fill.fee; } account.equity = account.cash; account.peakEquity = Math.max(account.peakEquity, account.equity); }
  private recordAnomaly(type: string, event: Partial<MarketEvent>, severity: string, detail: Record<string, unknown> = {}) { const anomaly = { id: `AN-${this.anomalies.length + 1}`, type, severity, symbol: event.symbol, timestamp: event.timestamp ?? new Date().toISOString(), sequence: event.sequence, detail }; this.anomalies.push(anomaly); return anomaly; }
  private seed(): void { const symbol = 'ALPHA'; const now = new Date('2026-09-30T09:30:00.000Z'); const at = now.toISOString(); const bids = [100.00, 99.99, 99.98, 99.97, 99.96].map((price, i) => ({ price, quantity: [420, 380, 610, 240, 720][i] })); const asks = [100.01, 100.02, 100.03, 100.04, 100.05].map((price, i) => ({ price, quantity: [300, 490, 260, 580, 410][i] })); this.ingest({ id: 'E-1', symbol, tradingDay: '2026-09-30', timestamp: at, receivedAt: at, sequence: 1, type: 'snapshot', bids, asks }); for (let i = 0; i < 12; i++) { const ts = new Date(now.getTime() + (i + 1) * 1000).toISOString(); this.ingest({ id: `E-${i + 2}`, symbol, tradingDay: '2026-09-30', timestamp: ts, receivedAt: ts, sequence: i + 2, type: i % 3 === 0 ? 'trade' : 'new_order', orderId: `M-${i + 2}`, side: i % 2 ? 'buy' : 'sell', aggressorSide: i % 2 ? 'buy' : 'sell', price: i % 2 ? 100.01 : 99.99, quantity: 40 + i * 12 }); } }
}
