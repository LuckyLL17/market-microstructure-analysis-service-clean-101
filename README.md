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
POST /api/market-data/events/batch
GET  /api/orderbook/:symbol
POST /api/replay/sessions
GET  /api/replay/sessions/:id
POST /api/replay/sessions/:id/step
POST /api/replay/sessions/:id/run
GET  /api/analytics/:symbol
GET  /api/analytics/:symbol/event-window
POST /api/analytics/:symbol/event-window
POST /api/sandbox/orders
POST /api/sandbox/cancel
GET  /api/sandbox/strategies/:strategyId/performance
GET  /api/sandbox/strategies/:strategyId/events
GET  /api/anomalies
GET  /api/metrics
```

### 事件窗口分析

`GET/POST /api/analytics/:symbol/event-window` 返回一段行情中多个时间点的 as-of
盘口与指标，与现有“当前快照”分析 `GET /api/analytics/:symbol` 并存、共用同一指标口径。

参数（GET 走 query string，POST 走 JSON body）：

| 参数 | 说明 |
| --- | --- |
| `tradingDay` | 单个交易日 `YYYY-MM-DD` |
| `tradingDayFrom` / `tradingDayTo` | 跨交易日范围（序列号按交易日各自独立） |
| `from` / `to` | ISO8601 闭区间时间范围；省略交易日时按 UTC 自然日推导 |
| `sampling` | `event`（每个事件一个 as-of 样本，默认）/ `interval`（固定毫秒网格）/ `points`（等分网格点） |
| `intervalMs` | interval 步长，默认 1000 |
| `points` | points 采样点数（含两端），默认 2 |
| `depth` | 盘口档位，默认 10，上限 50 |
| `maxSamples` | 样本数资源上限，默认 5000 |
| `maxEvents` | 窗口应用事件数资源上限，默认 200000，超限返回 `truncated=true` |

每个样本包含：as-of 盘口 `book`、价差/中间价/深度/失衡/冲击成本/成交概率/流动性评分
`analytics`、自上一样本以来的成交量 `trades` 与盘口变化 `changes`、锚点事件（id/序号/
类型/迟到毫秒）以及样本级异常（crossed_book、empty_book、wide_spread、stale_quote、
large_trade）。

顶层还返回：

- `eventOrder`：规范化后实际应用的事件顺序（事件时间+序列号），保留真实事件序列；
- `volume`：窗口内完整成交量（笔数、总量、金额、主买/主卖、买卖失衡、均量、最大成交）；
- `completeness`：重复序列（含同序号冲突替换 `supersededEvents`）、序列号缺口、晚到
  （事件时间早于 `receivedAt`）、到达顺序时间戳倒退、crossed/empty 计数；
- `empty` / `truncated` / `scannedEventCount` / `appliedEventCount`。

语义约定：

- 乱序事件按到达顺序应用于实时盘口，窗口分析按事件时间规范化重放，两者互不影响；
- 同日同序列号的完全重复只应用一次；不同 id 同序列号冲突时保留规范序中的一条并记录替换；
- 窗口起点之前的最后一个 snapshot 作为重放基线（加上其后的增量）；
- 空窗口：event 模式 0 样本；interval/points 仍产出网格点，盘口为空、无锚点并报 empty_book。

## 验证

```bash
npm test        # 事件窗口一致性/边界用例 + HTTP 端到端用例
npm run typecheck
```

覆盖种子数据、独立重放交叉核对、乱序/晚到/重复/缺口、空窗口、跨交易日查询，以及
12 万事件批量接入与 `maxSamples`/`maxEvents` 资源边界。

所有数据默认存储在内存中，适合作为后端业务原型和后续接入 PostgreSQL、TimescaleDB、Kafka/NATS 的基础。
