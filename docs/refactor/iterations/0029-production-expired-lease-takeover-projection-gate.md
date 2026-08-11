# Iteration 0029：Production Expired-Lease Takeover Projection Gate

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0030](../decisions/0030-production-expired-lease-takeover-projection-gate.md)
- 评测记录：[Eval 0025](../evals/0025-production-expired-lease-takeover-baseline.md)

## 目标

把 lease expiry/takeover 从 repository 与 queue 单项测试提升为版本化 production projection，证明未决 effect 存在时仍可安全接管，并由 token fencing 阻止旧 Worker 写入。

## 范围内

- 独立 takeover fixture、Zod observation 和 tracked Eval baseline；
- stale Worker claim 与 `model:plan:attempt:1` effect/trace reservation；
- DB-time lease expiry、production Worker attempt 2 与新 trace；
- 旧 run failed/lease_expired、旧 effect/trace uncertain/lease_takeover；
- uncertain key fail-closed 与 `plan:attempt:2` 有界恢复；
- completed article/done/outbox、共享 workflow expected 与 Next SSR；
- stale token effect finish/terminal settle 的 lease_lost 断言。

## 范围外

- 不实际 kill Worker 进程或制造 network partition；
- 不实现 uncertain effect resolver 或 provider result lookup；
- 不覆盖 BullMQ stalled redelivery、HTTP/SSE 或真实 provider；
- 不把 uncertain effect 当成可安全自动重放。

## 验证

- `pnpm test:contracts`：2 个文件、25 项通过；takeover fixture schema、共享 workflow expected 和 inventory 被锁定；
- `pnpm typecheck:contracts`、`pnpm typecheck:worker`：通过；
- `pnpm test:worker:production:local`：production Eval 4 项通过，takeover 1/1 exact-match；真实 PostgreSQL、Redis/BullMQ、Worker、Next build/API/SSR 联合流程通过；read model 含 3 条生成 article 与 1 条 legacy article，临时服务已停止。
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 348 项、Python 50 项，共 398 项通过；Web lint/build、全部 typecheck、migration check、38-case component gate 与 3-case workflow shadow gate 通过；
- `pnpm check:docs`：96 个 Markdown 文件链接通过；
- `git diff --check`：通过。

## 退出条件

1. 旧 attempt 已持有 lease 并 reserve 同一稳定 effect key：满足。
2. takeover 原子收敛旧 run/effect/trace 并创建 attempt 2：满足。
3. 新 attempt 不重复执行 uncertain key，使用有界新 attempt key 恢复：满足。
4. 最终 article/done/outbox 与共享 expected 一致：满足。
5. 旧 token 不能 finish effect 或 settle terminal：满足。

## 后续

1. 独立 Eval queue 与 worker；
2. production trace live sampler、retention/consent 与 CI artifact；
3. 固定 rubric/真实模型 grader；
4. reply/cancel 跨 workspace HTTP 负例和实际 source dry-run。
