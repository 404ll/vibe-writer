# Eval 0043：Memory Reconciliation 故障基线

- 日期：2026-08-07
- 结论：Passed for owner governance, idempotent resolution, bounded retry, budget settlement, and RLS; real provider evidence not evaluated
- 对应迭代：[0047](../iterations/0047-owner-controlled-memory-reconciliation.md)

## Resolution Matrix

| 场景 | effect | task | 后续调用 | 实际 |
|---|---|---|---|---|
| editor/viewer提交 | 不变 | uncertain | 拒绝 | passed |
| confirmed failed + hold | failed | failed | 不自动重试 | passed |
| confirmed failed + requeue | failed | queued | owner授权后可新attempt | passed |
| attempt达到max | uncertain | uncertain | 拒绝requeue | passed by contract |
| confirmed succeeded | succeeded + actual cost | failed/result unavailable | 禁止requeue | passed |
| budgeted但缺usage/cost | uncertain | uncertain | 拒绝resolution | passed by contract |
| pricing snapshot漂移 | uncertain | uncertain | 拒绝resolution | passed by contract |
| signal已擦除 + requeue | uncertain | uncertain | 拒绝 | passed |
| signal已擦除 + hold | failed | failed | 无source恢复 | passed |

## Concurrency 与 Audit

| 场景 | 预期 | 实际 |
|---|---|---|
| exact idempotency replay | 同一audit，`replayed=true` | passed |
| same key different decision | collision | passed |
| two PostgreSQL sessions | 一条audit，一次new + 一次replay | passed |
| effect second resolution | unique/collision拒绝 | passed |
| matching workspace RLS | owner/API role可见 | passed on real PostgreSQL |
| other workspace RLS | 0 rows | passed on real PostgreSQL |
| audit content | fingerprint、identity、metering，无source/model正文 | passed |

## 证据

- PGlite reconciliation：4/4；DB总计17个文件、114/114；
- 真实PostgreSQL：19/19，另有PostgresSaver 4/4、live sampler 1/1；
- migration drift：0；
- 根级`pnpm verify`：通过，覆盖contracts、runtime、eval、Memory、DB、Worker、API、Web build与文档链接检查。

## 未证明

- 未调用真实provider lookup或导入真实账单；
- operator attestation尚无双人审批或组织级审计；
- 没有reconciliation backlog scanner、告警、age SLO或管理UI；
- 没有可恢复provider result store，因此confirmed success只能终结而不能继续候选写入；
- production Memory extraction仍为No-Go。
