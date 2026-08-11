# Iteration 0027：Production Running Cancellation Projection Gate

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0028](../decisions/0028-production-running-cancellation-projection-gate.md)
- 评测记录：[Eval 0023](../evals/0023-production-running-cancellation-baseline.md)

## 目标

把取消从 queue/runner 单项测试提升为可版本化 production projection，证明真实 provider 调用进行中仍可经 heartbeat 中止，并以一个 fenced terminal transaction 收敛持久化状态。

## 范围内

- 独立 cancellation fixture、Zod observation 和 tracked Eval baseline；
- 阻塞中的 loopback Anthropic wire request；
- `running → cancel_requested → AbortSignal → cancelled`；
- cancelled job/run、terminal event、outbox、零 article 与 provider request 数断言；
- reserved effect 和 running trace 的 uncertain 收敛；
- topic 不进入 effect/trace 的隐私断言；
- TerminalRepository 的 trace terminalization 修复与 repository regression test。

## 范围外

- 不调用 HTTP cancel route 或浏览器 SSE；
- 不覆盖 queued/awaiting_input 取消、provider failure 或 lease takeover；
- 不访问真实 provider、托管 Redis/PostgreSQL 或反向代理；
- 不把 uncertain effect 自动重试或宣称 exactly-once。

## 验证

- `pnpm test:contracts`：2 个文件、23 项通过；cancellation fixture schema 与 inventory 被锁定；
- `pnpm --filter @vibe-writer/db test -- terminals.integration.test.ts`：DB 全套 10 个文件、61 项通过；failed/cancelled terminal 均把 reserved effect 与 running trace 收敛为 uncertain；
- `pnpm typecheck:contracts`、`pnpm typecheck:db`、`pnpm typecheck:worker`：通过；
- `pnpm test:worker:production:local`：production Eval 2 项通过，其中 cancellation 1/1 exact-match；真实 PostgreSQL、Redis/BullMQ、Worker、Next build/API/SSR 联合流程通过；临时服务已停止。
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 346 项、Python 50 项，共 396 项通过；Web lint/build、全部 typecheck、migration check、38-case component gate 与 3-case workflow shadow gate 通过；
- `pnpm check:docs`：90 个 Markdown 文件链接通过；
- `git diff --check`：通过。

## 退出条件

1. provider request 已发出后再请求取消：满足。
2. heartbeat 触发 AbortSignal，阻塞调用由 Worker 中止：满足。
3. job/run/event/outbox 在持久化层收敛且没有 article：满足。
4. reserved effect 与 running trace 不残留运行态：满足，均为 uncertain。
5. cancellation dataset/baseline 可独立版本和比较：满足。

## 后续

1. provider/graph terminal failure projection；
2. expired lease takeover 与旧 Worker fencing projection；
3. reply/cancel 跨 workspace HTTP 负例；
4. live sampler、独立 Eval queue 与 CI artifact retention。
