# Eval 0035：Memory Extraction Contract 基线

- 日期：2026-08-07
- 结论：Passed for trust-boundary contract; extractor quality not evaluated
- 对应迭代：[0039](../iterations/0039-trusted-envelope-memory-extraction-contract.md)

## Contract Matrix

| 场景 | 预期 | 实际 |
|---|---|---|
| valid model candidate + trusted envelope | complete proposal | passed |
| model supplies workspace/source/consent/expiry/proposer | strict rejection | passed |
| duplicate slot in one batch | whole batch rejected | passed |
| more than 20 candidates | schema rejection | passed |
| confidence outside 0–1 | schema rejection | passed |
| invalid trusted source run | envelope rejection | passed |
| empty candidate batch | empty proposals | passed |

证据来自 `@vibe-writer/memory-core` 的 5 个 extraction contract tests；加上 policy/review tests，package 共 16 项。既有 tracked Memory governance Eval保持 18/18。

根级门禁通过 TypeScript 415 项、Python 50 项，共 465 项；component 38/38、Memory governance 18/18、workflow shadow 3/3、Web lint/test/build、migration check 和 126 个 Markdown 链接均通过。

## 未证明

- 没有自然语言输入，也没有 extractor prompt/model；
- 没有 should-write precision/recall、slot accuracy 或 sensitive false-negative rate；
- 没有 prompt injection、provider malformed JSON、timeout/retry 或 cost evidence；
- 没有 outbox/Worker delivery、candidate submission 或 review UI；
- 没有 retrieval 或 answer uplift。
