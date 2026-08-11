# ADR-0010：Worker Lease 与 Fencing Token 协议

- 状态：Accepted
- 日期：2026-08-07

## 背景

R3 已建立 `jobs`、`runs`、`job_events` 与 outbox，R4 已建立纯 TypeScript Agent core 和 LangGraph workflow runtime，但尚没有 Worker 能安全取得任务执行权。现有 schema 只有 `lease_owner` 与 `lease_expires_at`：如果 Worker A 超时后 Worker B 接管，而 A 随后恢复，单靠 owner 或过期时间无法阻止 A 写入 heartbeat、终态或导出结果；同一 worker id 重启后还可能误认旧 lease。

BullMQ 的 active lock 只能约束队列消费，不能代替 PostgreSQL 业务状态的写入授权。重复投递、进程暂停、网络分区和超时接管都要求数据库拥有独立的 fencing 边界。

## 决定

1. 每次成功 claim 生成不可复用的随机 `lease_token`，同时写入 `jobs` 与对应 `runs`。`worker_id` 用于诊断，`lease_token` 才是 heartbeat、pause 和 settle 的授权凭证。
2. 数据库时间是 lease 权威时钟。claim、heartbeat 和 expiry 判断使用 PostgreSQL `now()`；应用传入 duration，但不传入“当前时间”。
3. claim 在单个事务内完成：只有 `queued` 或 lease 已过期的 `running` job 可以被取得；取消已请求、awaiting-input 和 terminal job 不可 claim。成功后创建新的 run attempt，过期的旧 running run 标记为 `failed/lease_expired`。
4. 同一 job 的 run attempt 由持有 job row lock 的 claim transaction 分配，继续由 `(job_id, attempt)` 唯一约束最终防重。重复队列消息在有效 lease 期间得到 `not_claimed`，不会创建第二个 run。
5. heartbeat 必须同时匹配 `job_id + run_id + lease_token + running`，并且 job 尚未请求取消。成功时同时续期 job/run；取消请求返回 `cancel_requested`，token 不匹配或 lease 已失效返回 `lease_lost`。
6. settle 在一个事务内同时更新 job 与 run，且必须匹配 fencing token。旧 Worker 即使最终完成模型调用，也不能覆盖新 attempt 的状态。terminal settle 清空 job lease；失败记录使用安全、受限长度的 error code/message。
7. 取消分两类：queued/awaiting-input 可在数据库直接进入 `cancelled`；running 只写 `cancel_requested_at`，由持有 lease 的 Worker abort 并以同 token settle cancelled。后续 reconciler 负责长期无 heartbeat 的取消收敛。
8. `apps/worker` 负责 heartbeat loop、AbortSignal 和执行/settle 编排；`packages/db` 只负责原子状态与授权，不依赖 BullMQ、LangGraph 或 provider。
9. Iteration 0009 用 PGlite 和 scripted executor 验证协议，但不声称真实多连接 PostgreSQL、BullMQ lock、进程 kill 或网络分区已经验证。真实 PostgreSQL fault-injection 属于 R5 后续集成门槛。
10. 本协议当前只 fencing `jobs/runs` 的 claim、heartbeat 与 settle 控制面。`job_events`、checkpoint、article/export、tool-call journal 等 Worker 副作用在接入前必须携带 run identity/fencing 授权或使用 attempt 隔离与幂等键；协作式 `AbortSignal` 不能替代写入授权。

## 不变量

- 任一时刻，一个 job 最多只有一个有效 fencing token；
- 每个成功 claim 恰好对应一个新的 run attempt；
- 旧 token 的 heartbeat/settle 永远不能修改新 claim；
- cancel requested 后不再续期，也不允许新的 claim；
- terminal job 没有 lease，terminal run 有 `finished_at`；
- Worker 业务正确性不依赖队列 exactly-once。

## 结果

- PostgreSQL 成为“谁有权提交本次执行”的最终真相；
- BullMQ 后续可以采用 at-least-once 投递：有效 lease 期间的重复消息会在 executor 前被 claim 吸收；模型、工具、event、checkpoint 与 export 的重复副作用仍需各自的 fencing/idempotency 设计；
- PostgresSaver 负责 graph checkpoint，job lease 负责业务写入授权，两者职责分开；
- 后续 PostgresSaver 集成必须定义 run-attempt namespace 与 takeover 隔离；export/article/event transaction 则要求 lease token 或等价授权，从而阻止 zombie Worker 副作用。

## 未选择

- 只使用 `worker_id`：进程重启或 id 复用时无法 fencing；
- 只相信 BullMQ lock：队列 lock 不是数据库写授权，也不能覆盖人工 resume 与其他投递来源；
- 应用机器时间计算 expiry：多主机时钟漂移会改变接管判断；
- 宣称 exactly-once：进程可能在外部调用成功后、checkpoint/settle 前崩溃，仍需幂等键和调用 journal。
