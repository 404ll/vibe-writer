# Iteration 0076：大纲修改恢复幂等与失败收敛

> 状态：Done
> 日期：2026-09-01

## 目标

修复用户提交大纲修改意见后，第二轮 `outline_ready` 与第一轮固定幂等键冲突，导致 BullMQ 重试、Worker lease 过期且 Job 长期残留 `running` 的问题。

## 范围内

- 每轮大纲确认使用 `jobId + interruptId` 组成稳定的 `outline_ready` 事件幂等键；
- 同一 interrupt 的 checkpoint replay 继续返回原事件，不消耗新的事件序号；
- 兼容部署前已持久化的 `job:{jobId}:awaiting:outline:v1` 事件；
- Worker 在 Graph 已返回、但暂停或完成投影抛错时，优先使用当前 lease 提交结构化失败终态；数据库不可用时仍把异常交给 BullMQ 有界重试；
- 本地产品 smoke 覆盖“首次大纲 → 要求修改 → 第二次大纲 → 确认 → 完成”。

## 范围外

- 不修改 Planner 风格 prompt；
- 不修改前端「实时日志」展示；
- 不新增数据库 schema 或 migration；
- 不自动修改或删除已经卡住的本地 Job 数据。

## 验证

- `pnpm --filter @vibe-writer/db exec vitest run tests/commands.integration.test.ts tests/terminals.integration.test.ts`：通过，2 files / 13 tests；
- `pnpm --filter @vibe-writer/worker exec vitest run tests/runner.test.ts`：通过，1 file / 12 tests；
- `pnpm --filter @vibe-writer/db exec vitest run --maxWorkers=1 <DB test inventory>`：通过，21 files / 136 tests；标准 `pnpm test:db` 在本机并发 4 个 PGlite 时出现初始化 timeout，因此未修改全局 timeout，而是用相同测试清单单 worker 重跑；
- `pnpm --filter @vibe-writer/worker exec vitest run --maxWorkers=1 <Worker test inventory>`：通过，14 files / 96 tests；
- `pnpm typecheck:db`、`pnpm typecheck:worker`：通过；
- `pnpm test:db:postgres:local`：通过，真实 PostgreSQL DB 21 tests、PostgresSaver 4 tests、live sampler 1 test，以及 Eval register/enqueue 幂等检查；
- `pnpm test:durable-product:local`：通过，真实本地 PostgreSQL/Redis/Next/Worker 与假模型依次产生两个 `outline_ready` 和一个 `done`，文章 edit/restore revision 为 `0 → 1 → 2`；
- `pnpm check:docs`、`git diff --check`：通过。

## 剩余风险

- 本迭代只处理结果投影抛错后的即时失败收敛；若 Worker 在无机会执行收尾代码时进程退出，仍依赖 lease takeover 或未来 reconciler 收敛失联 Job。
