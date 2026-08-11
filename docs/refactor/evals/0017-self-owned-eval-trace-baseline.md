# Eval 0017：Self-owned Eval 与 Run Trace 基线

- 日期：2026-08-07
- 结论：Passed for scoped deterministic/infra baseline
- 对应迭代：[0021](../iterations/0021-self-owned-eval-and-run-trace.md)

## Dataset 与版本

| 项目 | 值 |
|---|---|
| dataset id | `self-owned-eval-trace-baseline` |
| schema version | `eval-report-v1` / Drizzle migration `20260807051314` |
| target | `@vibe-writer/eval-core`、`@vibe-writer/db`、production Worker composition |
| model profile | deterministic scripted / local Anthropic wire-compatible server |
| prompt | `prompt-v1` 或 production composition manifest |
| graph | `graph-v1` / `writer-graph-v1-target-2026-08-07` |
| tool | `search-v1` / production manifest |
| code revision | 当前 dirty worktree；未 commit |

## 覆盖矩阵

| 能力 | 证据 | 结果 |
|---|---|---|
| canonical dataset fingerprint | case 顺序和 object key 顺序变化得到同一 SHA-256 | Passed |
| identity collision | 重复 case/evaluator identity、同 suite version 不同 dataset | Rejected |
| output privacy default | report/trial 只保存 output fingerprint | Passed |
| error privacy | target/grader 原始异常正文不进入 report | Passed |
| error attribution | target error、score error 和 completed/failed run 分离 | Passed |
| completeness gate | 缺 trial 的 run 不能完成 | Passed |
| trace migration | populated legacy null `trace_id` 先回填再加 NOT NULL | Passed |
| effect/trace transaction | reserve 创建 running span，finish 写 token/provider/latency | Passed |
| terminal uncertainty | 未完成 span 随 run terminal 进入 uncertain | Passed |
| production composition | 5 个 local provider call → 5 effect + 5 succeeded span | Passed |
| sensitive payload exclusion | prompt、正文、query 不出现在 trace/eval default report | Passed |

## 命令证据

```text
pnpm test:eval-core
pnpm test:db
pnpm test:worker
pnpm typecheck:eval-core
pnpm typecheck:db
pnpm typecheck:worker
pnpm check:migrations
pnpm test:db:postgres:local
pnpm test:worker:production:local
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
pnpm check:docs
git diff --check
```

结果：

- contracts 20、model runtime 9、provider runtime 5；
- eval core 5、agent core 93、workflow runtime 48；
- DB 57、checkpoint runtime 8、Worker 49；
- Python API 50、Web 27；
- migration check、所有 TypeScript typecheck、Web lint、Next production build通过；
- 72 份 Markdown 相对链接通过；
- `git diff --check` 通过；
- 真实 PostgreSQL 9 + PostgresSaver 4 通过；
- production PostgreSQL + Redis + Worker + local provider + Next.js + SQLite migration联合链路通过，临时服务均停止。

## 未执行/不能声称

- 没有真实付费 provider、真实用户文章 dataset 或固定主观 rubric，因此不能声称文章质量等价或提升；
- 没有 shadow 流量、线上采样、CI baseline compare 或 Langfuse export；
- 没有 auth/workspace/RLS，opaque namespace 不证明多租户隔离；
- 没有 production consent/retention policy，不允许批量导入用户正文；
- 没有 Memory extraction/retrieval，因此本次不覆盖 memory quality。

## 结论

本次证明了可扩展 Eval/Trace 的最小自有数据平面，而不是完成 R7。后续可以在不修改 Agent core、workflow runtime 或 provider port 的前提下增加 queue、shadow、grader 和 observability adapter；公开切流仍保持 No-Go。
