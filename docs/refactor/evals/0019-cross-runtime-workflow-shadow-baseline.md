# Eval 0019：跨运行时 Workflow Shadow 基线

- 日期：2026-08-07
- 结论：Passed for deterministic graph-level cross-runtime workflow shadow
- 对应迭代：[0023](../iterations/0023-cross-runtime-workflow-shadow-gate.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `workflow-shadow-regression@2026-08-07-v1` |
| dataset | `workflow-shadow-baseline-v1` |
| dataset fingerprint | `sha256:03ed4e181fb2f1dc5d2b66e637535dc72517b8eeba6decea0e0a3ec59a0d03ce` |
| target | `python-typescript-workflow-shadow@v1` |
| evaluator | `normalized-workflow-equivalence@v1` |
| model profile | `scripted:cross-runtime-workflow-v1` |
| graph | `python-c47cbfd0ab1f+writer-graph-v1-target-2026-08-07` |
| provider/tool | `scripted-workflow-adapters-v1` |
| code revision | 运行时对 Python/TS graph、contracts、eval-core 和 driver 计算 SHA-256 |

## Gate

| 指标 | Gate |
|---|---:|
| unique cases | 3 |
| trials | 3 |
| target errors | 0 |
| evaluator errors | 0 |
| cross-runtime scores | 3 |
| pass rate | 1.0 |

每个 score 要求 compatibility runtime 命中 expected、target runtime 命中 expected，并且双方 observation 一致。

## 命令

```text
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm test:eval-cli
pnpm typecheck:eval-cli
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm eval:workflow-shadow
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
pnpm check:docs
git diff --check
```

## 未证明

- 不是 Worker/queue/database/checkpoint 的跨运行时 production E2E；
- 不证明 Python wait loop 与 TypeScript durable interrupt 内部语义相同；
- 不覆盖真实 provider、搜索、tool call、取消、异常终态、并行章节或文章质量；
- 不包含 live/shadow production traffic、用户内容、auth/RLS 或 Memory 指标。

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| unique cases | 3 | 3 | Passed |
| trials | 3 | 3 | Passed |
| target errors | 0 | 0 | Passed |
| evaluator errors | 0 | 0 | Passed |
| cross-runtime scores | 3 | 3 | Passed |
| pass rate | 1.0 | 1.0 | Passed |

三个场景中，Python 和 TypeScript observation 均命中各自 case 的显式 expected，且双方 canonical fingerprint 相同。根级 verify 同时通过 TypeScript 336 项、Python 50 项，共 386 项测试；Web lint/build、全部 typecheck、migration check、38-case component gate 和 78 个 Markdown 文件链接检查也通过。

该结果把迁移证据从 component 扩展到真实 graph control flow，但结论严格限定为 scripted、graph-level product observation。production composition shadow/e2e 与 live quality eval 仍是公开切流门槛。
