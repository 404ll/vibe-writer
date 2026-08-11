# Eval 0034：Deterministic Memory Governance 基线

- 日期：2026-08-07
- 结论：Passed for deterministic policy and review transition; model extraction and retrieval not evaluated
- 对应迭代：[0038](../iterations/0038-deterministic-memory-governance-eval.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `memory-governance-regression@2026-08-07-v1` |
| dataset fingerprint | `sha256:c8e9d4272a9a1b83611de447b0614c1f198ff2a532655a27840a56617dd9716f` |
| target | `memory-policy-and-review-transition@2026-08-07-v1` |
| evaluator | `canonical-memory-governance-match@v1` |
| cases / trials | 18 / 18 |
| model profile | `none:deterministic-memory-policy` |
| capture output | false |

## Coverage Matrix

| 维度 | Cases | 结果 |
|---|---:|---|
| proposal eligibility / normalization | 2 | 2/2 |
| exact duplicate / changed conflict | 2 | 2/2 |
| confidence / sensitive / expiry rejection | 3 | 3/3 |
| explicit user sensitive proposal | 1 | 1/1 |
| cross-workspace / unknown-field failure | 2 | 2/2 |
| create / stale / unexpected replacement | 3 | 3/3 |
| conflict replacement identity / kind | 3 | 3/3 |
| revision increment / invalid revision | 2 | 2/2 |

最终 metric `memory_governance_exact_match` 为 18/18，target error 0、evaluator error 0。tracked baseline 固定全部 case key、dataset fingerprint、suite/target version、score count 和 100% pass rate。report 只保留 output fingerprint 与 score，不 capture proposal decision output；synthetic proposal 只存在于源码 dataset。

根级门禁通过 TypeScript 410 项、Python 50 项，共 460 项；component 38/38、Memory governance 18/18、workflow shadow 3/3、Web lint/test/build、migration check 和 123 个 Markdown 链接均通过。

## 未证明

- case 是手写规则矩阵，不代表真实用户表达分布；
- 没有 extractor prompt/model 的 precision、recall、latency 或 cost；
- 没有 sensitive classifier false-negative rate；
- 没有 semantic duplicate/contradiction 合并；
- 没有 retrieval recall@k、context precision、answer uplift 或跨 subject 泄漏测试。
