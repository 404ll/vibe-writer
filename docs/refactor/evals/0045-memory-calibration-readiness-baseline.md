# Eval 0045：Memory Calibration Readiness 基线

- 日期：2026-08-07
- 结论：Passed for dual provider identity and offline No-Go readiness; live model quality, actual cost, and request-level terminal resolution remain unevaluated
- 对应迭代：[0049](../iterations/0049-provider-dual-identity-and-calibration-readiness.md)

## Tracked plan

| 字段 | 固定值 |
|---|---|
| suite | `memory-extraction-quality@2026-08-07-v1` |
| dataset | 24 cases，tracked SHA-256 fingerprint |
| prompt / extractor | `2026-08-07-v1` / `v1` |
| trials | 3 per case，精确72 calls |
| output capture | false |
| required metering | usage + HTTP request id + response object id |
| model / pricing / cost cap | 未绑定 |
| readiness | `no_go` |

## 故障矩阵

| 条件 | 预期 | 实际 |
|---|---|---|
| tracked manifest + baseline | deterministic No-Go | passed |
| productionEligible被手工改为true | parser拒绝 | passed |
| dataset fingerprint漂移 | readiness拒绝 | passed |
| call budget少于完整trial inventory | parser拒绝 | passed |
| 非官方source或必需blocker缺失 | parser拒绝 | passed |
| HTTP request id缺失 | 不用Message id补位 | passed |
| request identity drift | 不写reconciliation audit | passed |
| response identity drift | 不写reconciliation audit | passed |

## 证据

- Eval CLI：10个文件、37项（33 passed、4 skipped），类型检查通过；
- readiness CLI：`status=no_go`、`productionEligible=false`、`automaticUncertainResolutionEligible=false`；
- DB PGlite：17个文件、116/116，migration drift为0；
- Worker：12个文件、78/78；provider-runtime：3个文件、11/11；
- 真实PostgreSQL local gate与根级`pnpm verify`通过；Markdown链接和diff whitespace门禁通过。

## No-Go blockers

1. `model_unselected`；
2. `pricing_snapshot_unbound`；
3. `live_trials_missing`；
4. `request_level_terminal_lookup_unavailable`。

## 未证明

- 没有真实Anthropic请求，不证明任何model达到should-write质量gate；
- 没有实际账单样本，不证明pricing snapshot或reservation误差；
- 当前API审计不提供同步request-level terminal lookup，因此不证明automatic uncertain resolution安全；
- planned 72 calls不是付费授权，runner和credentials composition尚未实现；
- production Memory extraction继续No-Go。
