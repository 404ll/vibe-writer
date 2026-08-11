# Iteration 0038：Deterministic Memory Governance Eval

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0039](../decisions/0039-deterministic-memory-governance-eval.md)
- 评测记录：[Eval 0034](../evals/0034-deterministic-memory-governance-baseline.md)

## 目标

在接入 model extractor 前，将 should-write policy、duplicate/conflict 和 review/revision transition 固定为可版本化、可比较、无供应商成本的 Eval gate。

## 范围内

- `planMemoryReviewTransition()` 纯 policy 与 repository 接入；
- 18-case synthetic Memory governance dataset；
- stable suite/target/evaluator identity 与 dataset fingerprint；
- tracked exact-match baseline；
- content-free run report；
- CLI 的 check/report/baseline 命令；
- Eval architecture boundary 与根级 verify gate。

## 范围外

- 不调用真实或 scripted model extractor；
- 不测自然语言 should-write precision/recall；
- 不测 PII/sensitive classifier、semantic dedupe 或 contradiction resolution；
- 不测 PostgreSQL repository、RLS 或删除；这些由 Iteration 0037 的 integration gate 负责；
- 不测 embedding、retrieval 或 answer uplift。

## 验证

- `pnpm test:memory-core`：2 个文件、11 项通过；
- `pnpm test:eval-cli`：加入 Memory suite 与 architecture gate；
- `pnpm typecheck:memory-core`、`pnpm typecheck:eval-cli`、`pnpm typecheck:db`：通过；
- `pnpm eval:memory`：18 cases / 18 trials，target error 0、evaluator error 0、exact match 18/18；dataset fingerprint `sha256:c8e9d4272a9a1b83611de447b0614c1f198ff2a532655a27840a56617dd9716f`；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 410 项、Python 50 项，共 460 项通过；component 38/38、Memory governance 18/18、workflow shadow 3/3、Web lint/test/build、全部 typecheck/migration check 和 123 个 Markdown 链接通过；
- `git diff --check`：通过。

## 退出条件

1. proposal 和 review transition 都有 stable case identity：满足。
2. duplicate/conflict、privacy/expiry 和 stale/replace/revision 均被覆盖：满足。
3. report 不保存 proposal/output 内容：满足。
4. baseline drift 能使 CLI 非零退出：满足。
5. suite 不依赖 DB、queue、provider、LangGraph 或 Web：满足。
6. 根级门禁执行 suite：满足。

## 后续

1. 建立 versioned extractor contract 和 synthetic utterance dataset；
2. 先用 scripted extractor 打通 outbox/Worker/candidate 写入，再进行付费 model calibration；
3. 为 should-write precision/recall、sensitive false-negative rate 增加独立指标；
4. 建立 expiry scheduler 与 backlog/erasure latency 指标；
5. retrieval 进入独立 suite，不复用 governance exact-match 作为质量结论。
