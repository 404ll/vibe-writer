# ADR-0015：Durable Interrupt Command 与 API 切流边界

- 状态：Accepted
- 日期：2026-08-07

## 背景

当前 Python `POST /jobs/:id/reply` 只把回复写进进程内 dict，再用 `asyncio.Event` 唤醒等待中的 graph。进程重启会丢 reply、等待状态和 live subscriber。TypeScript graph 已能把 outline interrupt 持久化进 PostgresSaver，Worker 也会把 job 投影为 `awaiting_input`，但还没有 durable interrupt/command 业务记录，也没有安全的 requeue 边界。

Next.js 当前把 `/api/*` rewrite 到 FastAPI。直接在同一路径加入 Route Handler 会立即改变生产语义；而新的 Node API 在 Worker、dispatcher、真实 provider 和数据迁移未就绪时还不能承接现有流量。

## 决定

1. 新增 `job_interrupts` 与 `job_commands` 业务表。checkpointer 保存框架恢复 envelope；业务表只保存可审计的 interrupt id/type/payload、reply payload/fingerprint、状态和时间，不读取 LangGraph 内部序列化表。
2. outline interrupt 的 LangGraph id 必须进入 `WorkerExecutionResult.awaiting_input`。`pauseClaim()` 在同一 fenced transaction 中写 pending interrupt、`outline_ready` event、`awaiting_input` job 和已结束 run；不能先写 checkpoint 后只改内存状态。
3. 一个 interrupt 最多接受一个 outline reply。相同 payload 重试返回 replay；不同 payload 返回 idempotency collision，不能静默覆盖用户已经提交的命令。
4. reply transaction 锁定 job/pending interrupt，写 command，把 interrupt 标为 replied，把 job 从 `awaiting_input` 变为 `queued`，并写唯一 resume outbox event。command 本身不直接调用 Worker 或 LangGraph。初次 enqueue 使用 `write-{jobId}`；resume 必须使用基于 resume outbox event id 的另一稳定 delivery id，否则 BullMQ 会把仍保留的 completed 初次 job 当作重复并吞掉恢复投递。
5. Worker claim 后先恢复 stable checkpoint。如果结果仍是 interrupt，则按 interrupt id 查询 durable command；有 command 时用 `resumeOutline(command)` 继续，无 command 时保持 awaiting-input。若 checkpoint 已前进到非 interrupt 状态，只 replay，不重复应用 command。
6. event history API 直接读取 `job_events(job_id, seq)`；SSE 以 after-seq catch-up + 有界轮询/keepalive 实现，PostgreSQL 是重放真相。Redis Pub/Sub 可后续降低延迟，但不是正确性依赖。
7. Node API 第一阶段放在显式 durable 路径或 feature flag 后，不覆盖现有 `/api/* → FastAPI` rewrite。只有 Worker/provider/dispatcher、数据迁移与 shadow eval 满足切流门槛后，浏览器 `API_BASE` 才切换。
8. create/reply/cancel 必须使用共享 Zod contract；错误响应不暴露数据库、provider、checkpoint 或 lease 细节。SSE 只输出 `JobEventSchema` 允许的 event/data。
9. cancellation 的业务结果以 PostgreSQL 状态/event 为准。live Worker 通过 heartbeat 收敛；queued/awaiting-input 取消必须原子写 cancelled event，不能只有状态没有审计事件。
10. API route 与 repository 均不持有全局用户内容缓存。连接池可以进程复用，但关闭、测试隔离、环境校验和 server-only 边界必须显式。

## 不变量

- 一个 pending interrupt 至多有一个 command；reply 不丢失、不覆盖、不直接依赖进程内唤醒。
- reply 成功与 resume outbox 同事务；不能出现“API 返回成功但永远不再投递”。
- command 只对匹配的 interrupt 生效；旧 interrupt/reply 不能恢复新的 checkpoint。
- events/SSE 重连可以重复读取，但客户端按 `_seq` 幂等；数据库序号不能跳跃或倒退。
- Durable API 未显式启用前，现有 FastAPI 产品路径保持不变。

## 未选择

- 继续使用内存 Event/Promise 唤醒：重启和多实例会丢命令。
- 把 reply 直接放进 Redis job payload：Redis retention 不是业务审计。
- reply API 直接调用 graph：HTTP 生命周期、lease 和 Worker 并发边界会混在一起。
- API 读取 LangGraph checkpoint 内表寻找 interrupt：把业务接口绑定到框架私有 envelope。
- 立即用 Next Route Handler 覆盖现有 rewrite：当前还没有可运行的真实 provider/Worker deployment。
