# 市场微观结构分析服务

纯后端 Node.js + TypeScript 服务，用于订单簿事件接入、历史行情重放、市场微观结构指标分析、策略沙盒、风险校验和撮合仿真。

## 能力范围

- 订单簿快照、逐笔成交、新单、撤单、行情事件接入
- 按交易日与时间顺序重放市场状态，支持单步、倍速运行
- 盘口深度、价差、订单失衡、冲击成本、成交概率、滑点、流动性指标
- 策略沙盒限价单/市价单模拟，保留资金、持仓、成交与审计轨迹
- 资金、持仓、下单频率、撤单率、价格偏离、最大回撤风险规则
- 价格优先/时间优先的基础撮合与部分成交
- 策略收益、风险暴露、最大回撤、成交率与异常交易事件

## 启动

```bash
npm install
npm run dev
```

服务默认运行在 `http://127.0.0.1:6190`。

## 关键接口

```text
GET  /api/health
GET  /api/instruments
POST /api/market-data/events
GET  /api/orderbook/:symbol
POST /api/replay/sessions
GET  /api/replay/sessions/:id
POST /api/replay/sessions/:id/step
POST /api/replay/sessions/:id/run
GET  /api/analytics/:symbol
POST /api/analytics/window
POST /api/sandbox/orders
POST /api/sandbox/cancel
GET  /api/sandbox/strategies/:strategyId/performance
GET  /api/sandbox/strategies/:strategyId/events
GET  /api/anomalies
GET  /api/metrics
```

所有数据默认存储在内存中，适合作为后端业务原型和后续接入 PostgreSQL、TimescaleDB、Kafka/NATS 的基础。

## 事件窗口分析

`GET /api/analytics/:symbol` 只返回当前盘口；`POST /api/analytics/window` 则按一段行情返回
每个采样点的 as-of 盘口与指标，并保留规范化后的实际事件顺序（按 `timestamp, sequence, 接入顺序` 排序重放，而非接入顺序）。

```json
POST /api/analytics/window
{
  "symbol": "ALPHA",
  "tradingDay": "2026-09-30",
  "from": "2026-09-30T09:30:00.000Z",
  "to": "2026-09-30T10:00:00.000Z",
  "sampling": "event | interval | points",
  "maxSamples": 500,
  "intervalMs": 1000,
  "points": ["2026-09-30T09:35:00.000Z"],
  "depth": 10,
  "impactQuantities": [100, 500, 1000]
}
```

- 时间范围可只给 `tradingDay`（按 UTC 自然日展开），或给 `from/to`，也可同时给（不一致时时间范围为准并告警）。
- `event`：每个（或均匀抽样后的）事件产出一个样本；`interval`：固定网格 as-of 快照；`points`：指定时间点 as-of 快照。
- 每个样本含：盘口档位、价差/相对价差、买卖深度、失衡/加权失衡、买卖冲击成本、成交概率、流动性评分，
  以及距上一样本的成交量/额/笔数、各交易日累计成交量。
- 窗口前事件会作为盘前基线重放（含跨交易日的多个日初快照），因此窗口起点的 as-of 状态完整。
- 异常处理：重复序列拒绝重放但计数并在事件清单标记；序列缺口按交易日分别判定；
  晚到事件（时间更晚但接入更早）按事件时间归位重放并标记，区别于接入侧实时异常；
  crossed/locked 盘口聚合告警；空窗口在 `event` 模式返回空样本、在 `interval/points` 模式返回基线 as-of 样本。
- 资源边界：单次重放事件数上限 200,000（超出返回 400 `WINDOW_TOO_LARGE`），样本硬上限 5,000，
  事件清单 10,000 条、明细异常 500 条（计数不截断）。

验证：`npm test`（种子数据一致性、三种采样、乱序/晚到/缺口/重复、空窗口、跨交易日、大批量与边界、HTTP 集成）。

