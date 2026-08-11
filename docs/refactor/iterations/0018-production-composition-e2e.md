# Iteration 0018：Production Composition E2E

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker/API cutover
- 对应决策：[ADR-0019](../decisions/0019-production-composition-integration-gate.md)

## 目标

在同一条可重复本地链路中证明真实 PostgreSQL、Redis/BullMQ、production Worker composition、PostgresSaver、provider adapter、fenced effects 与 terminal transaction 能共同完成一次写作任务。

## 范围内

- 一次性 PostgreSQL database、Redis container 与强制清理；
- Drizzle migration + PostgresSaver setup；
- production `role=all` runtime 与真实 outbox dispatcher/consumer；
- 本地 Anthropic wire-compatible HTTP provider；
- job → outbox → queue → run → graph → effect → article/done；
- metadata 内容最小化和 runtime close 幂等断言；
- 独立 root/package test command 与文档。

## 范围外

- 不调用真实 Anthropic/Tavily，不评价生成质量、限流或成本；
- 不测试 Next.js durable routes、浏览器 SSE 或 API_BASE 切流；
- 不发送 OS SIGTERM/kill，不注入 provider/DB/Redis 网络分区；
- 不验证 dispatcher/consumer 跨进程部署、托管服务或连接代理；
- 不实现 uncertain resolver、auth/tenant 或 SQLite backfill。

## 实现结果

- `scripts/run-production-integration.mjs` 同时创建带随机身份的一次性 PostgreSQL 与 Redis，传入专用 URL 后运行 Worker production suite，并在 finally 中停止两者。
- suite 拒绝非 loopback target，并校验数据库名与 shared comment中的 harness id，降低误连真实数据库的风险。
- 本地 provider按真实 Anthropic Messages schema返回 plan、coverage、writer、chapter review和 full review；production adapter和 effect wrapper未被替换。
- 一次任务最终得到一个 completed job、一个 article、一个顺序为 0 的 `done`、一个 published outbox，以及 5 个预期 key的 succeeded model effects。
- article正文没有出现在 effect journal，runtime连续 close两次不报错。

## 验证证据

- `pnpm test:worker:production:local`：1/1 通过；真实 PostgreSQL与Redis均启动、使用并正常停止。
- `pnpm typecheck:worker`：通过，包含 production integration suite。
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model 9、provider 5、agent 93、workflow 48、DB 47、checkpoint 8、worker 47、Python API 50、Web 22；migration、lint、build、docs 全通过。
- `git diff --check`：通过。
- Iteration 0017 的真实 PostgreSQL 9+4 和真实 Redis 8 仍是组件回归前置；本迭代联合结果见 [Eval 0014](../evals/0014-production-composition-baseline.md)。

## 遗留边界

- 该测试证明 composition root，不证明真实 provider账号、文章质量或生产网络。
- OS signal、进程崩溃与网络分区故障注入仍需 staging process harness。
- 下一步应形成切流 runbook与最小部署/健康检查，再决定 auth/tenant和 SQLite article迁移策略；未满足前浏览器继续走 Python基线。
