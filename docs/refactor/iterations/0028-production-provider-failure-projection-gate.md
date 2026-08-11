# Iteration 0028：Production Provider Failure Projection Gate

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0029](../decisions/0029-production-provider-failure-projection-gate.md)
- 评测记录：[Eval 0024](../evals/0024-production-provider-failure-baseline.md)

## 目标

把 provider 失败从 adapter/component 单项测试提升为可版本化 production projection，证明真实 5xx 会经过有界领域重试，并在 effect、trace、job/run、event 与 outbox 各层留下可解释且一致的终态。

## 范围内

- 独立 provider-failure fixture、Zod observation 和 tracked Eval baseline；
- loopback Anthropic HTTP 503；
- Planner service exception 的两次有界尝试；
- failed effect/trace 的 `provider_unavailable`；
- failed job/run 的 `workflow_service_exception`；
- error event、published outbox、零 article 与隐私断言。

## 范围外

- 不覆盖 timeout、429、authentication、partial response 或网络分区；
- 不实现 job/run 级自动重试；
- 不覆盖 lease takeover、HTTP/SSE 或真实 provider；
- 不改变现有 component retry policy。

## 验证

- `pnpm test:contracts`：2 个文件、24 项通过；failure fixture schema 与 inventory 被锁定；
- `pnpm typecheck:contracts`、`pnpm typecheck:worker`：通过；
- `pnpm test:worker:production:local`：production Eval 3 项通过，provider failure 1/1 exact-match；真实 PostgreSQL、Redis/BullMQ、Worker、Next build/API/SSR 联合流程通过；临时服务已停止。
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 347 项、Python 50 项，共 397 项通过；Web lint/build、全部 typecheck、migration check、38-case component gate 与 3-case workflow shadow gate 通过；
- `pnpm check:docs`：93 个 Markdown 文件链接通过；
- `git diff --check`：通过。

## 退出条件

1. provider 确实收到两次 wire request 并返回 503：满足。
2. 每次尝试都形成 failed effect 与 failed trace：满足。
3. 两次领域尝试后 job/run 原子进入 failed：满足。
4. error event/outbox 存在且没有 article：满足。
5. 业务错误码与 provider 诊断错误码分层：满足。

## 后续

1. expired lease takeover 与旧 Worker fencing projection；
2. reply/cancel 跨 workspace HTTP 负例；
3. live sampler、独立 Eval queue 与 CI artifact retention；
4. timeout/rate-limit 等 failure taxonomy 在真实需求出现时增量建 case。
