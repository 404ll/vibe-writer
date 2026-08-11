# Eval 0036：Scripted Memory Delivery 基线

- 日期：2026-08-07
- 结论：Passed for durable pointer delivery and idempotent candidate submission; real extractor quality not evaluated
- 对应迭代：[0040](../iterations/0040-scripted-memory-extraction-delivery.md)

## Delivery Matrix

| 场景 | 预期 | 实际 |
|---|---|---|
| terminal commit | article/done/completed + Memory outbox同事务 | passed |
| terminal replay | one extraction outbox identity | passed |
| outbox → Redis | `{schemaVersion, runId}` only | passed |
| separate queue | `extract.memory` / `memory-{runId}` | passed |
| completed source load | terminal article revision 0 | passed |
| valid scripted proposal | pending candidate | passed |
| sensitive model inference | policy rejected, no row | passed |
| duplicate queue processing | existing candidate, no duplicate row | passed |
| candidate submission | no active Memory | passed |
| malformed queue payload | unrecoverable before source read | passed |

PGlite Worker/DB suites分别为52项和92项；真实 Redis suite为9项。真实 PostgreSQL回归为DB 14项、PostgresSaver 4项、live sampler 1项。

根级工程门禁 `pnpm verify` 通过：TypeScript 419 项、Python 50 项，共 469 项测试；component Eval 38/38、Memory governance Eval 18/18、workflow shadow Eval 3/3；Next.js production build与 129 份 Markdown链接检查通过。

## 未证明

- 没有真实 extractor prompt/model、usage、cost或provider retry；
- 没有 effect ledger，不能安全接收费模型；
- 没有 should-write precision/recall、slot accuracy或sensitive false-negative rate；
- production runtime尚未启用 Memory publisher/consumer；
- 没有 atomic batch、expiry scheduler、管理 UI或 retrieval。

后续基线：[Eval 0037](./0037-fenced-memory-extraction-baseline.md)已覆盖attempt/effect ledger、真实PostgreSQL并发claim/RLS和ambiguous provider outcome；本记录仍只代表Iteration 0040当时的delivery能力。
