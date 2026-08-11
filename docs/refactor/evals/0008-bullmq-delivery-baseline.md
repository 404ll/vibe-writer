# Eval 0008：BullMQ Delivery 基线

- 日期：2026-08-07
- Protocol：`write-job-envelope-v1-target-2026-08-07`
- Queue：BullMQ 5.81.0 / Redis 7.4 Alpine
- 状态：Passed（本地隔离 Redis 基线）

## 评测范围

验证 outbox claim fencing、BullMQ publish/consume 分类、重复 delivery、stalled recovery 和 shutdown。它不运行真实模型、不评价文章质量，也不证明 Next.js API 已切流。

## 当前结果

完整本地基线通过：

| 层级 | 结果 | 证明范围 |
|---|---:|---|
| DB/PGlite | 33/33 | outbox token claim、stale takeover、retry/terminal release 及既有 repository |
| Worker protocol | 26/26 | minimal envelope、deterministic id、dispatch backoff、busy/terminal 分类、BullMQ error mapping |
| real PostgreSQL | 6/6 | 两个 session 下 outbox single claim/旧 token 拒绝及既有 fencing |
| real PostgresSaver | 4/4 | 新 migration 未破坏 checkpoint 恢复基线 |
| BullMQ/Redis | 7/7 | duplicate add、不同 delivery/单 DB run、outbox E2E、retry/fail-fast、cancel、stalled、shutdown |

Redis suite 由 `scripts/run-redis-integration.mjs` 创建随机 test id、容器名、label 和 loopback ephemeral port，使用 `redis:7.4-alpine`，结束后验证进程退出并由 `--rm` 删除。测试中的 durable repository 使用 PGlite；真实 PostgreSQL 的 outbox multi-session claim/fencing 由同轮 DB 6/6 suite 单独证明。

首次设计把所有 `not_claimed` 都 ack。stalled 场景审计发现这可能在原执行随后崩溃时丢失重投，因此协议改为：busy retry，terminal/awaiting-input/not-found ack。真实 stalled test 最终观察到三次 delivery 进入 runner，但只创建一个 DB run、执行一次 executor，并完成业务 job。

## 运行命令

```bash
pnpm --filter @vibe-writer/worker test
pnpm test:worker:redis:local
pnpm test:db:postgres:local
```

## 计划指标

- outbox repository 单元/真实 PostgreSQL通过数；
- deterministic publisher/processor contract 通过数；
- duplicate publish 后实际 Redis job 数；
- stalled 后 redelivery 次数与 DB run attempt 数；
- graceful/forced shutdown 恢复时间；
- unrecoverable 与 retryable failure 分类。

## 不代表什么

- BullMQ 至少一次投递不等于业务 exactly-once；
- Redis job history 不是业务审计、memory 或 eval dataset；
- 本地 Redis 不代表托管 Redis、网络分区或生产 failover。
