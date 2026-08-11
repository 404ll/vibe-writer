# Eval 0038：Memory Extraction Quality 基线

- 日期：2026-08-07
- 结论：Passed for deterministic calibration harness; real provider quality and production readiness not evaluated
- 对应迭代：[0042](../iterations/0042-provenance-aware-memory-extraction-calibration.md)

## Dataset

- suite：`memory-extraction-quality@2026-08-07-v1`
- prompt：`durable-user-memory-extractor@2026-08-07-v1`
- reference target：`reference-memory-extractor@2026-08-07-v1`
- dataset fingerprint：`sha256:cdf98abed426776a4617dd09c0b8e9f116c6e247106ab3b5659fcce4642f4a01`
- 24个synthetic bilingual cases：10个durable positive，3个task instruction，3个assistant generated，3个sensitive trap，5个ambiguous negative。

数据集不包含真实用户内容。expected candidate与reference target分别维护，避免target在运行时读取case expected；但两者仍是同一轮人工设计的synthetic oracle，所以只能用于验证评测脚手架和后续回归。

## Quality Matrix

| 指标 | Gate | Reference结果 |
|---|---:|---:|
| should-write precision | >= 1.0 | 1.0 |
| should-write recall | >= 1.0 | 1.0 |
| should-write accuracy | >= 1.0 | 1.0 |
| positive slot exact | >= 1.0 | 1.0 |
| invalid output | <= 0 | 0 |
| task instruction leak | <= 0 | 0 |
| assistant-generated leak | <= 0 | 0 |
| sensitive leak | <= 0 | 0 |

Confusion matrix为10 TP、0 FP、0 FN、14 TN；24个逐案例score全部通过。adversarial test会让target对所有case写candidate，确认14个false positive和三类各3个leak都会使gate失败。

## 运行方式

```bash
pnpm eval:memory-extraction
pnpm eval:memory-extraction:report
pnpm eval:memory-extraction:baseline
```

`check`只读tracked baseline。`baseline`只向stdout打印候选，不自动接受dataset变化。修改case、prompt或reference target时必须提升相应版本并人工审查新基线。

## 未证明

- reference target不是provider/model调用，不证明真实模型precision、recall、稳定性或成本；
- 当前source run只有task-scoped topic和assistant-generated article，没有可写入长期Memory的durable user segment；
- 没有真实去标识化conversation分布、多段冲突、跨语言归一化或human label agreement；
- 没有hard cost budget、pricing freshness、production consumer、retrieval或answer-uplift；
- 因此production Memory extraction仍是No-Go。
