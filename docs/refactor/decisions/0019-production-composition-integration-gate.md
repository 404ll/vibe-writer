# ADR-0019：Production Composition 联合验证门禁

- 状态：Accepted
- 日期：2026-08-07

## 背景

此前真实 PostgreSQL 与真实 Redis/BullMQ 回归各自通过，但使用的是不同 harness：前者不启动队列和 production Worker，后者主要以 PGlite/scripted executor 验证 delivery。二者不能证明 `createProductionWorkerRuntime()` 的真实装配能在同一套基础设施中完成 outbox、claim、checkpoint、provider、effect journal 和 terminal transaction。

## 决定

1. 新增独立的 destructive local integration gate，同时创建一次性 PostgreSQL database 与隔离 Redis container；测试目标必须是 loopback，数据库名和 shared database comment 必须携带随机 harness id。
2. harness 先运行受控 Drizzle migration，再由 production runtime 自行 setup PostgresSaver schema；测试不依赖开发机已有业务表或 Redis key。
3. 使用 `role=all` 的真实 `createProductionWorkerRuntime()`，覆盖 dispatcher、BullMQ publisher/consumer、DB runner、LangGraph/PostgresSaver、Anthropic adapter、effect wrapper 和 terminal repository。
4. 模型端使用本地 Anthropic wire-compatible server，不注入 scripted service，不需要收费 key。它验证真实 HTTP mapping 与 composition，但不评价模型质量或供应商账号可用性。
5. 退出条件包括：outbox published、job completed、唯一 article/done、预期的 5 个 succeeded effects、敏感正文未进入 effect metadata，以及 runtime close 幂等。
6. harness 无论成功失败都停止 Redis/PostgreSQL；若 PostgreSQL 无法停止，保留临时目录并报错，不静默删除仍在运行的数据目录。
7. 该 gate 独立于快速 `pnpm verify`，因为它需要本地 PostgreSQL binaries 与 Docker。发布/切流前必须显式运行并记录结果。

## 不变量

- 联合测试不得连接非 loopback PostgreSQL/Redis。
- Redis payload 仍只携带 job pointer；业务状态、effect 和 article 只能以 PostgreSQL 为真相。
- 本地 fake provider 不能被描述为 live provider eval。
- composition E2E 失败时不能用分离的 PostgreSQL/Redis 测试替代结论。

## 明确限制

测试在 Vitest 进程内调用 production composition，并通过 `runtime.close()` 验证关闭；它没有发送 OS SIGTERM、kill -9 或制造网络分区，也没有经过 Next.js durable API。真实 provider、独立 dispatcher/consumer deployment、代理/托管数据库和浏览器切流仍需后续 staging/runbook。
