# Writer–Reviewer Production Baseline

> 日期：2026-09-03

## 目的

固定全文 Writer–Reviewer Graph 在真实 PostgreSQL、Redis/BullMQ、Worker、PostgresSaver、effect journal、trace 与 Article terminal transaction 中的 durable 投影。

## 版本

| 场景 | Dataset | Suite/target |
|---|---|---|
| completed + outline resume | `production-composition-baseline-v3` | `2026-09-03-v3` / `v3` |
| running cancellation | `production-cancellation-baseline-v2` | `2026-09-03-v2` / `v2` |
| provider failure | `production-failure-baseline-v2` | `2026-09-03-v2` / `v2` |
| expired lease takeover | `production-takeover-baseline-v2` | `2026-09-03-v2` / `v2` |

新 baseline 显式要求 `stage_update`、全文草稿、Reviewer 和 export 里程碑；happy path 的 provider/effect/trace 从旧逐章链的 5 次收敛为 `planner.plan`、`writer-agent.compose`、`reviewer-agent.review` 3 次。outline resume 仍要求两个 run、两个 published outbox 和两个 trace identity；cancellation、503 retry 与 lease fencing 语义保持不变。

## 证据

`pnpm test:worker:production:local` 使用一次性 loopback PostgreSQL/Redis 与 fake Anthropic wire server，5/5 cases 通过，并继续执行 production `next build`。该测试不访问真实搜索服务，也不证明模型文章质量。
