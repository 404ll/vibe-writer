# Iteration 0012：BullMQ Outbox 与 Consumer

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker cutover
- 对应决策：[ADR-0013](../decisions/0013-bullmq-delivery-and-postgres-outbox-fencing.md)

## 目标

把 transactional outbox、BullMQ transport 与 queue-neutral `WorkerJobRunner` 接起来，同时保持 PostgreSQL lease 是执行授权真相，并证明重复 publish/delivery、stalled recovery 与 shutdown 不会绕过 fencing。

## 范围内

- outbox lock token、claim/release/published repository 与 forward migration；
- versioned minimal queue envelope 与 deterministic BullMQ job id；
- BullMQ publisher、processor、worker lifecycle 和 failure classification；
- duplicate delivery、outbox crash window、retry/unrecoverable、graceful shutdown tests；
- 隔离 Redis 下的真实 multi-worker/stalled integration；
- ADR、Iteration、Eval、系统设计和验证记录。

## 范围外

- 不接 Next.js create/cancel/reply/SSE route；
- 不注入真实 provider 或完整 workflow executor；
- 不实现 terminal article/event transaction、outbox daemon supervisor 或生产部署；
- 不实现 memory/RAG/eval product schema；
- 不删除 Python/FastAPI。

## 必须证明的行为

1. create job 与 enqueue outbox 仍同事务且幂等；
2. 多 dispatcher 通过 `SKIP LOCKED` 不领取同一 row；
3. stale publishing 可接管，旧 lock token 不能 mark/release；
4. publish 成功/mark 失败后重试使用相同 BullMQ job id；
5. queue payload 只包含 schemaVersion/jobId，非法 payload fail fast；
6. duplicate delivery 只有一个 DB claim/executor；
7. business terminal 结果 ack，lease lost/临时错误 retry，schema 错误 unrecoverable；
8. stalled delivery 被再次领取时仍经过 DB lease；
9. graceful close 不领取新 job，强制退出依赖 stalled+lease expiry 恢复；
10. 全仓 verify、真实 PostgreSQL/Redis integration、文档链接与 diff check 通过。

## 当前状态

已完成实现、隔离 Redis/PostgreSQL 与全仓证据：

- `outbox_events` 新增不可复用的 `lock_token`；forward migration 会把升级时遗留的 `publishing` row 安全退回 `pending`，避免无 token 的永久锁；
- `OutboxRepository` 实现 `FOR UPDATE SKIP LOCKED` claim、stale takeover、token-fenced mark/release 与 bounded error；
- `OutboxDispatcher` 固定 `{ schemaVersion: 1, jobId }` 最小 payload、无冒号 deterministic queue id、指数退避、非法/耗尽分类；
- `processWriteQueueJob` 固定 business terminal ack、busy/lease-lost retry 和非法 schema unrecoverable；`WorkerJobRunner` 在 claim 失败后区分 busy、terminal、awaiting-input 和 not-found，避免 stalled duplicate 过早 ack；
- `BullMqWritePublisher`/`BullMqWriteWorker` 使用 BullMQ 5.81.0，固定 bounded retry/retention/payload、显式 start/close 和必需的 error/failed/stalled observer；
- Docker harness 创建带随机名称/label/loopback port 的 Redis 7.4 Alpine 容器，结束后 stop 并 `--rm`；
- PGlite DB 33/33、Worker 26/26、真实 Redis 7/7、真实 PostgreSQL DB 6/6、PostgresSaver 4/4 通过。

真实 Redis suite 证明 deterministic duplicate add 只保留一个 queue job；两个不同 delivery 指向同一 job 时只创建一个 DB run/executor；transactional outbox 可经 BullMQ 完成数据库 job；lease-lost retry 与非法 envelope fail-fast 分离；DB cancellation 会通过 heartbeat abort 并 ack；stalled redelivery 经过 busy retry 后仍只有一个 DB run；graceful close 等待 active job 且不领取下一条。

## 验证

| 命令 | 结果 |
|---|---|
| `pnpm --filter @vibe-writer/db test` | 4 files / 33 tests passed |
| `pnpm --filter @vibe-writer/worker test` | 3 files / 26 tests passed |
| `pnpm test:worker:redis:local` | Redis/BullMQ 1 file / 7 tests passed；容器已清理 |
| `pnpm test:db:postgres:local` | PostgreSQL DB 6/6；PostgresSaver 4/4；cluster 已停止并清理 |
| `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify` | passed |
| `git diff --check` | passed |

## 剩余风险

- 本地单节点 Redis 不代表托管 Redis failover、TLS、ACL、网络分区或跨区域延迟；
- 当前没有常驻 outbox dispatcher supervisor、reconciler 或生产健康检查；
- BullMQ consumer 已接到 lease runner，但尚未注入 Postgres checkpoint workflow executor/真实 provider；
- Next.js create/reply/cancel/SSE route 尚未切到 durable PostgreSQL/BullMQ 路径；
- terminal article/event transaction 仍未实现，不能把 queue completion 当文章已持久化。

## 回滚

BullMQ 尚未进入产品请求链路。若 migration 未进入共享环境，可移除新增 adapter/schema/test；若已应用，使用 forward compensating migration。现有 FastAPI 路径不读取 Redis 或新 outbox lock token。
