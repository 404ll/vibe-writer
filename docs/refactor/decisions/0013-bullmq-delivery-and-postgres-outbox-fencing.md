# ADR-0013：BullMQ 投递与 PostgreSQL Outbox Fencing

- 状态：Accepted
- 日期：2026-08-07

## 背景

Iteration 0004 已让创建 job 与 `job.enqueue.requested` outbox 同事务提交，Iteration 0009–0011 已让 Worker 通过 PostgreSQL lease、effect journal 和 checkpoint attempt 取得执行授权。但 `apps/worker` 仍是 queue-neutral runner：没有 outbox dispatcher、BullMQ publisher、consumer 或进程入口。

BullMQ 的 job lock 和 PostgreSQL lease 不是同一件事。BullMQ 的 stalled job 会回到 waiting，队列整体是至少一次处理语义；processor 可能重复执行。官方文档也要求把 stalled 当作可能 double processing 的信号，并建议 graceful shutdown 调用 `worker.close()`。自定义 job id 只在记录仍保留于队列时去重，删除后同 id 可以再次加入，而且 id 不能包含 `:`。参考 [Stalled jobs](https://docs.bullmq.io/guide/jobs/stalled)、[Job IDs](https://docs.bullmq.io/guide/jobs/job-ids)、[Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs) 与 [Graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown)。

因此 Redis 不能成为“任务是否应该执行”的业务真相，也不能用 BullMQ lock 代替 DB fencing。outbox 在 publish 成功、DB mark published 前崩溃时也必然存在重复 publish 窗口。

## 决定

1. PostgreSQL 继续是 job/outbox/run 的事实来源。BullMQ 只负责至少一次 transport、并发控制、backoff 与 stalled recovery；consumer 每次都必须调用 `WorkerJobRunner.run(jobId)` 重新取得 DB lease。
2. 新增 outbox repository，使用 `FOR UPDATE SKIP LOCKED` 领取 ready row；每次领取生成不可复用的 `lock_token`。mark published/release failure 必须同时匹配 event id、`publishing` 状态和 token，不能只依赖 dispatcher id。
3. stale `publishing` row 超过 lock timeout 后可以被重新领取。publish 使用 write-first/mark-second：Redis 成功而 DB mark 失败会再次发布，但 deterministic BullMQ job id 和 DB claim 会吸收重复；不宣称跨 Redis/PostgreSQL exactly-once。
4. queue payload 固定为最小版本化 envelope：`{ schemaVersion: 1, jobId }`。topic、prompt、模型配置、checkpoint 或用户正文不复制到 Redis，consumer 只从 PostgreSQL 读取业务输入。
5. BullMQ queue name、prefix、connection、concurrency 和 retention 由启动层配置；领域 runner 不导入 BullMQ。adapter 可以导入 BullMQ，但不得拥有 SQL/schema。
6. publisher 使用不含冒号的 deterministic `jobId = write-{jobId}`，保留 completed/failed 记录一段有界时间。队列去重只是降噪；记录清理后再次投递仍由 DB job 状态/lease 保证安全。
7. processor 对结果分类：`completed | failed | cancelled` 正常 ack；`not_claimed` 必须继续区分 `busy | terminal | awaiting_input | not_found`。`busy` 与 `lease_lost`、数据库/adapter 临时异常进入 BullMQ backoff；其余三种不再需要当前 write delivery，可以 ack。非法 schema/job name 抛 `UnrecoverableError`，不消耗无意义重试。不能把 busy duplicate 提前 ack，否则 stalled 原执行随后崩溃时可能失去唯一重投机会。
8. business `failed` 已由 runner 在 PostgreSQL settle，因此 BullMQ job 可以 completed；队列失败表示“投递/基础设施没有成功交给可授权 runner”，不能与文章生成失败混成同一状态。
9. 默认 automatic attempts 必须有界并使用 exponential backoff+jitter；failed job 保留供诊断。长期失败或 attempts 耗尽由 reconciler 依据 DB 的 queued/running/expired 状态重新投递或终结，不能只看 Redis failed set。
10. Worker 使用显式 start/close 生命周期，启动前注册 error/failed/stalled 观察器；shutdown 停止领取新任务并等待当前 processor。强制退出仍依赖 stalled redelivery 与 DB lease expiry。
11. 本迭代使用精确版本 BullMQ 5.81.0，并以 harness 创建、标记和自动删除的 Redis 7.4 Alpine 容器验证 duplicate delivery、DB claim、stalled recovery、取消和 graceful shutdown；只通过 mock 不算退出。

## 不变量

- Redis 中没有无法从 PostgreSQL 恢复的唯一业务状态；
- 任意重复 delivery 都必须先经过 DB claim；
- outbox 旧 token 不能 mark 新 dispatcher 的发布结果；
- BullMQ completion 不等于业务成功，业务终态以 `jobs/runs` 为准；
- queue payload 不承载长期 memory、checkpoint 或用户正文。

## 结果

- API 可以只负责创建 job/outbox，dispatcher 与 consumer 独立扩缩容；
- Redis 重启、重复 publish、stalled delivery 不会绕过已有 lease/checkpoint fencing；
- 后续 memory/eval 仍消费 PostgreSQL run/event/trace 投影，不依赖 BullMQ 内部历史。

## 未选择

- API 事务提交后直接 `queue.add()`：DB 成功、Redis 失败会丢任务；
- BullMQ job lock 作为唯一执行锁：stalled/lock loss 会重复执行且不能 fencing 业务写入；
- `removeOnComplete: true` 立即删除：会扩大 outbox crash window 中的重复入队；
- 把整个写作请求放进 Redis：复制敏感内容并造成 DB/queue 双真相；
- queue processor 对所有结果都 throw：会把已持久化的 business failure 误当 transport failure。
