# Eval 0037：Fenced Memory Extraction 基线

- 日期：2026-08-07
- 结论：Passed for durable claim/effect fencing and content-free metering; real extractor quality and cost enforcement not evaluated
- 对应迭代：[0041](../iterations/0041-fenced-memory-extraction-effects.md)

## Fencing Matrix

| 场景 | 预期 | 实际 |
|---|---|---|
| concurrent DB claim | one claimed, one busy | passed on real PostgreSQL sessions |
| execution snapshot drift | reject before new attempt | passed |
| first reservation | provider may execute | passed |
| repeated reservation | no second provider call | passed |
| known failed effect | new numbered attempt within budget | passed |
| unknown provider outcome | task/effect uncertain, terminal | passed |
| expired reserved effect | uncertain, no takeover call | passed on real PostgreSQL |
| succeeded effect + candidate failure | uncertain, no automatic replay | passed |
| completed queue replay | original counts, extractor called once | passed |
| metering | provider/request/usage/cost/latency only | passed |
| workspace isolation | tasks/attempts/effects RLS | passed with non-owner role |
| Redis delivery | pointer-only independent queue still works | passed |

PGlite DB suite为97项，Worker suite为55项；真实PostgreSQL suite为15项，PostgresSaver为4项，live sampler为1项；真实Redis suite为9项。

根级工程门禁 `pnpm verify` 通过：TypeScript 427项、Python 50项，共477项测试；component Eval 38/38、Memory governance Eval 18/18、workflow shadow Eval 3/3；Next.js production build与132份Markdown链接检查通过。

## 未证明

- 没有真实extractor prompt、structured-output adapter或provider账号；
- 没有hard cost budget、workspace quota和pricing freshness gate；
- 没有should-write precision/recall、slot accuracy或sensitive false-negative rate；
- 没有provider result resolver，`uncertain`需要人工或后续reconciliation；
- production Memory consumer仍未启用；
- 没有atomic candidate batch、expiry scheduler、管理UI或retrieval。
