# Eval 0032：Memory Policy Kernel 基线

- 日期：2026-08-07
- 结论：Passed for deterministic pre-persistence policy; durable Memory not evaluated
- 对应迭代：[0036](../iterations/0036-versioned-memory-policy-kernel.md)

## Identity

| 项目 | 值 |
|---|---|
| package | `@vibe-writer/memory-core@0.1.0` |
| proposal schema | `1` |
| policy | `2026-08-07-v1` |
| model confidence floor | `0.8` |
| maximum normalized content | 4,096 characters |
| fingerprint | SHA-256 over normalized content |

## Policy Matrix

| 场景 | 预期 | 实际 |
|---|---|---|
| eligible proposal, no active slot | candidate | candidate |
| same slot + same fingerprint | duplicate | duplicate |
| same slot + changed fingerprint | conflict | conflict |
| model-proposed sensitive inference | rejected | sensitive_inference |
| model confidence below 0.8 | rejected | low_confidence |
| expires at/before DB-equivalent clock | rejected | expired |
| unknown field | schema failure | schema failure |
| cross-workspace active comparison | failure | failure |

根级门禁通过 TypeScript 395 项、Python 50 项，共 445 项；component 38/38、workflow shadow 3/3、Web lint/test/build、migration check 和 117 个 Markdown 链接均通过。

## 未证明

- 没有真实 extractor、human review、PostgreSQL、RLS、revision、evidence 或 deletion；
- 没有 semantic duplicate、contradiction resolution、PII detector 或 sensitive taxonomy quality；
- 没有 should-write precision/recall、retrieval recall@k、context precision 或 answer uplift；
- 没有把 Memory 注入 LangGraph state、prompt 或 user-visible management UI。
