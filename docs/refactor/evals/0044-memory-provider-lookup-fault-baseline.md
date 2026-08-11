# Eval 0044：Memory Provider Lookup 故障基线

- 日期：2026-08-07
- 结论：Passed for provider-neutral lookup semantics, content-free evidence, idempotent orchestration, snapshot cost settlement, and real-database target isolation; live provider support and quality remain unevaluated
- 对应迭代：[0048](../iterations/0048-provider-neutral-memory-request-lookup.md)

## 状态矩阵

| lookup结果 | ledger变更 | provider重放 | 实际 |
|---|---|---|---|
| succeeded + strict usage | confirmed success并按snapshot结算 | 0 | passed |
| failed + 默认设置 | confirmed failure + hold | 0 | passed |
| failed + owner bounded requeue | confirmed failure + queued | 后续仅新attempt | passed |
| pending | 无 | 0 | passed |
| not_found | 无，不推断失败 | 0 | passed |
| missing request id | 无且不调用adapter | 0 | passed |
| unsupported provider | 无且不调用adapter | 0 | passed |
| transport error | 无 | 0 | passed |
| response identity drift | 无并拒绝 | 0 | passed |
| erased source + requeue | 查询前拒绝 | 0 | passed |
| exact completed replay | 返回既有audit | 0次额外lookup | passed |
| same version + changed rates | reservation前拒绝 | 0 | passed |
| completed key + changed retry intent | idempotency collision | 0次额外lookup | passed |

## 数据与隐私边界

- lookup input只含provider、model和request id；
- terminal evidence只含status、identity、usage、failure code和SHA-256 fingerprint；
- application service不接收provider output，reconciliation audit不保存prompt或候选正文；
- pricing由durable execution snapshot提供，adapter不能以当前价格覆盖历史snapshot；
- `not_found`只表示当前查询没有证据，不是零费用或provider失败证明。

## 证据

- provider-runtime：3个文件、11/11，类型检查通过；
- DB PGlite：17个文件、114/114；migration drift为0；
- Worker unit + PGlite ledger integration：12个文件、78/78，类型检查通过；
- 真实PostgreSQL local gate：通过，含owner target、双session reconciliation和RLS；
- 根级`pnpm verify`：通过，覆盖contracts、runtime、eval、Memory、DB、Worker、API、Web production build与153个Markdown链接。

## 未证明

- 没有真实provider adapter或付费请求，因此不证明request lookup API可用；
- 没有真实usage与账单对账，不证明pricing准确或reservation误差范围；
- scripted状态不评价Memory should-write质量；
- 没有backlog scanner、SLO、告警、HTTP/UI或双人审批；
- production Memory extraction保持No-Go。
