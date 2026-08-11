# Iteration 0024：Durable Production Projection Gate

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0025](../decisions/0025-versioned-durable-production-projection-gate.md)
- 评测记录：[Eval 0020](../evals/0020-durable-production-projection-baseline.md)

## 目标

把跨运行时 workflow expected 继续投影到真实 PostgreSQL、Redis/BullMQ、Worker、PostgresSaver、terminal transaction 和 Next.js durable read path，并形成版本化、可阻断的 production projection gate。

## 范围内

- 新增 production composition fixture/schema；
- fixture 通过 `workflow_case_id` 复用 graph shadow happy-path expected；
- production Worker integration 作为真实 Eval target；
- 规范化并比较 job/run/article/event/outbox/effect/trace/provider observation；
- 建立 tracked production baseline；
- 联合 harness 继续验证 SQLite migration 和 Next SSR；
- 更新系统设计、路线图、ADR、迭代和 Eval 证据。

## 范围外

- 不在联合 harness 启动 Python FastAPI；
- 不访问付费 provider、真实搜索或用户内容；
- 不加入普通 root verify；
- 不新增部署、切流或实际 source migration；
- 不覆盖 production outline reply、cancel/failure/takeover 或多章节场景。

## Durable Observation

| 维度 | 当前 expected |
|---|---|
| job/run | `completed` / `[completed]` |
| article | 1 条、revision 0、与 workflow expected 相同的 canonical Markdown |
| events | `[done]` |
| outbox | `[published]` |
| effects | 5 个稳定 effect key，全部 succeeded |
| trace | 5 个 operation、1 个 trace id，全部 succeeded |
| provider | 5 次真实 Anthropic wire request |

## 验证

- `pnpm test:contracts`：2 个文件、22 项通过；
- `pnpm typecheck:contracts`、`pnpm typecheck:worker`：通过；
- `pnpm test:worker:production:local`：真实 PostgreSQL + Redis/BullMQ + Worker composition Eval 1/1 通过；legacy SQLite dry-run/apply/replay、Next durable build/API/SSR 同环境通过；临时服务随后停止并清理；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 337 项、Python 50 项，共 387 项测试通过；Web lint/build、全部 typecheck、migration check、component gate 与 workflow shadow gate通过；
- `pnpm check:docs`：81 个 Markdown 文件链接通过；
- `git diff --check`：通过。

## 退出条件

1. production fixture 与 workflow expected 建立可校验链接：满足。
2. Eval target 实际穿过 PostgreSQL/outbox/Redis/Worker/PostgresSaver：满足。
3. durable article/event/effect/trace observation 命中 tracked baseline：满足。
4. terminal 正文未进入 effect/trace：满足。
5. Next SSR 从同一 PostgreSQL 读取生成和迁移文章：满足。
6. failure/cancel/reply/takeover production suite、live eval：未满足，明确留后续。

## 回滚

恢复旧 production integration fixture 并删除 composition schema/baseline 不改变产品 runtime，但会失去从跨语言 workflow expected 到 durable projection 的连续证据。已有单项 Worker/DB/Redis 测试仍可保留。

## 后续

1. 增加 outline reply、cancel、terminal failure 和 lease takeover production case；
2. 生成 content-free CI/release artifact 并关联 Eval run id；
3. auth/workspace 后把 Eval namespace 与 principal/RLS 绑定；
4. 在真实 staging 执行 source migration dry-run 和 sampled live eval；
5. Memory 落地后增加 isolation/retrieval/answer-gain composition case。
