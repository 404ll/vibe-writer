# Eval 0010：Durable Reply/SSE 基线

- 日期：2026-08-07
- Protocol：`durable-reply-sse-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

验证 outline interrupt、用户 command、resume outbox、checkpoint resume 和 SSE read model 的持久化/幂等边界。它不运行真实模型，也不代表现有产品流量已切到 Node API。

## 计划覆盖

- interrupt/reply transaction 与 payload collision；
- reply 后 requeue/claim/resume；
- crash/takeover 下 command 不重复应用；
- queued/awaiting cancel terminal event；
- events after-seq、SSE keepalive、terminal close；
- Durable API disabled/current FastAPI rewrite compatibility；
- 真实 PostgreSQL 多 session 与真实 Redis delivery。

## 结果

| 层级 | 结果 | 证明范围 |
|---|---:|---|
| DB/PGlite | 44/44 | interrupt/command、reply replay/collision、resume outbox、queued/awaiting cancel event |
| Worker/PGlite | 36/36 | interrupt id、durable command lookup、checkpoint resume、command 不重复应用 |
| Web | 18/18 | durable create fail-closed/contract、SSE after-seq/terminal/abort 与现有 UI |
| Real PostgreSQL | 8/8 + 4/4 | multi-session reply single winner/replay 与 PostgresSaver |
| Real Redis/BullMQ | 8/8 | resume outbox distinct delivery、second claim 与 terminal completion |
| Full verify | Passed | TS/Python/Web/migration/docs 全链路 |

实现中发现：若 resume 继续使用初次 `write-{jobId}`，BullMQ 默认保留的 completed job 会阻止第二次执行。协议因此改为：初次 job id 对 job 去重，resume job id 对 outbox event 去重。真实 Redis suite 已证明 reply 能通过新的 delivery id 进入第二次 DB claim，最终只有一个 article 和连续的 `outline_ready → done`。

## 结论与限制

本基线证明 scripted workflow 的 reply 是 PostgreSQL durable command，且 events/SSE read model 能按 seq 重放；它不证明 durable API 已承接产品流量，也不证明真实 provider、认证、生产连接数和长连接代理行为。
