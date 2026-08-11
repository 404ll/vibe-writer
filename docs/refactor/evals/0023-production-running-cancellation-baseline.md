# Eval 0023：Production Running Cancellation 基线

- 日期：2026-08-07
- 结论：Passed for synthetic in-flight production cancellation
- 对应迭代：[0027](../iterations/0027-production-running-cancellation-projection-gate.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `production-cancellation-regression@2026-08-07-v1` |
| dataset | `production-cancellation-baseline-v1` |
| dataset fingerprint | `sha256:20e6fb2613f46d0ee2aed173b70f8f8b0c3e848f20d17b565739ce26ab83eb60` |
| target | `typescript-durable-production-cancellation@v1` |
| metric | `durable_cancellation_exact_match` |
| cases | running provider call cancelled |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| unique cases | 1 | 1 | Passed |
| target/evaluator errors | 0 | 0 | Passed |
| exact-match scores | 1 | 1 | Passed |
| pass rate | 1.0 | 1.0 | Passed |

规范化投影为：`jobStatus=cancelled`、`runStatuses=[cancelled]`、`articleCount=0`、`eventTypes=[cancelled]`、`outboxStatuses=[published]`、`effectStatuses=[uncertain]`、`traceStatuses=[uncertain]`、一次 provider request，取消写入结果为 `cancel_requested`。

## 联合证据

- loopback provider 已完整接收一次 request 后保持连接，不主动产生响应；
- job 进入 running 后写入取消请求，heartbeat 观察到请求并 abort executor/provider；
- terminal transaction 同时提交 cancelled event、job/run terminal、reserved effect 与 running trace 的 uncertain 状态；
- 没有 article，effect/trace 不包含 topic；
- production composition 的 happy/resume case 仍通过，Next production build/API/SSR 联合流程通过；
- PostgreSQL、Redis 和 Next 在结束后停止。

根级门禁另通过 TypeScript 346 项、Python 50 项，共 396 项测试，以及 Web lint/build、全部 typecheck、migration check、38-case component gate、3-case workflow shadow gate和90个 Markdown链接检查。

## 未证明

- HTTP cancel route、跨 workspace 授权和浏览器 SSE；
- provider failure、lease expiry/takeover、OS kill 与网络分区；
- 外部 provider 是否已产生不可回滚副作用；因此 effect/trace 保持 uncertain。
