# Eval 0041：Typed Memory Delivery 故障基线

- 日期：2026-08-07
- 结论：Passed for typed delivery, erasure fencing, and content-free queue transport; real-model quality and production enablement not evaluated
- 对应迭代：[0045](../iterations/0045-typed-memory-extraction-delivery.md)

## Delivery Contract

| 场景 | 预期 | 实际 |
|---|---|---|
| terminal run outbox | v2 tagged run pointer | passed |
| explicit signal outbox | 与signal create同事务写v2 pointer | passed |
| BullMQ job identity | `memory-run-{id}` / `memory-signal-{id}` | passed on real Redis |
| queue data privacy | 不含topic/article/signal text | passed on PGlite and real Redis |
| exact legacy v1 run | 升级为typed run pointer | passed |
| legacy extra field / invalid UUID | fail closed before source read | passed |
| signal model output forged subject | trusted principal subject覆盖 | passed |

## Erasure Fault Matrix

| 删除时点 | task | attempt/effect | 迟到调用 | 实际 |
|---|---|---|---|---|
| queued | `cancelled` | 无attempt/effect | 新claim不可读取source | passed |
| running、未reservation | `cancelled` | attempt `cancelled`，无effect | heartbeat `lease_lost` | passed |
| provider已reservation | `uncertain` | attempt/effect `uncertain` | finish `lease_lost` | passed on PGlite and real PostgreSQL |
| extraction已completed | 保持`completed`并detach | completed/succeeded metadata保留 | source-derived Memory级联删除 | passed |

detached task只保存source UUID、kind、删除时间、执行版本与content-free usage/cost/effect metadata；signal正文、subject和evidence不复制到账本。数据库check禁止detached queued/running row。

## 证据

- PGlite DB：107/107；
- Worker：62/62；
- 真实PostgreSQL：17/17，另有PostgresSaver 4/4、live sampler 1/1；
- 真实Redis/BullMQ：9/9；
- migration drift：0。

## 未证明

- 未调用真实Memory extractor模型，不能声称should-write或slot质量；
- 未验证真实provider取消能力或账单对账，只证明本地effect fencing；
- 未建立`uncertain`自动/人工reconciliation；
- 未验证staging consent API、expiry scheduler或production shadow；
- 未实现embedding/cache删除传播和retrieval/answer uplift Eval。
