# ADR-0011：Fenced Effects 与 Checkpoint Attempt 隔离

- 状态：Accepted
- 日期：2026-08-07

## 背景

ADR-0010 已让 PostgreSQL lease token 成为 job/run claim、heartbeat 与 settle 的写入授权，但这还不足以保护模型/工具调用、SSE event、article/export 与 LangGraph checkpoint。`AbortSignal` 只能请求协作式停止；旧 Worker 可能在 lease 过期后从网络暂停中恢复，provider 也可能在本地记录落库前已经完成外部调用。

只在执行前检查一次 token 同样不构成 fencing：检查返回后 lease 可能立即被接管。需要把授权检查与数据库写入放在同一事务，并为不能与 PostgreSQL 原子提交的外部调用记录 durable idempotency/uncertainty 状态。

PostgresSaver 还有额外问题：它管理框架 checkpoint envelope，不能让旧 attempt 与新 attempt 继续写同一 namespace，否则 takeover 后旧 Worker 仍可能污染新 Worker 的恢复点。

## 决定

1. 所有 Worker-owned 数据库写入携带 `job_id + run_id + lease_token`，并在数据库事务内校验 job/run 仍 running、token 匹配、lease 未过期且未请求取消。应用层先读再写不算授权。
2. run 产生的非终态 SSE event 使用 job-scoped `idempotency_key` 和 payload fingerprint。repository 在锁定当前 job row 后检查 lease、run 与幂等键，再分配连续 seq；同 key/同 payload 即使跨 attempt 也返回已有 event，同 key/不同 payload 视为 collision。已有 event 保留最初产生它的 run id。
3. `done/cancelled/error` 不通过普通 progress-event API 写入。终态 event 必须在未来 settle/article transaction 中与 job/run 终结一起提交，避免“状态终结但终态事件丢失”或相反。
4. 引入 `run_effects` journal，记录 `effect_key`、kind、canonical JSON SHA-256 request fingerprint、owner run、状态和 bounded result metadata。所有 adapter 使用共享 fingerprint helper；effect key 在 job 内唯一，并传给支持幂等的 provider。
5. effect reservation 必须持有有效 lease。首次 reservation 返回 `reserved`；同 run 重复 reservation 返回 `already_reserved`；已成功项返回 `previously_succeeded` 与 bounded metadata；旧 attempt 留下的 reserved 项进入 `uncertain`，新 attempt 默认不得盲目重放。`previously_succeeded` 不保证完整模型/工具输出可恢复，adapter 仍需 checkpoint、provider read API 或专用 resolver。
6. effect completion/failure 也必须持有同一 run 的有效 lease。旧 Worker 在 takeover 后不能把 journal 标成 succeeded/failed。外部调用已成功但 completion 未提交的 crash window 仍是 `uncertain`，不能宣称 exactly-once。
7. takeover 会把旧 attempt 的未完成 effect 标为 `uncertain`。后续 resolver 只能依据 provider idempotency/read-after-write 能力、人工确认或显式 retry policy 收敛；不同 effect kind 不共享一个隐式默认重试策略。
8. LangGraph checkpoint 使用 per-run attempt namespace。新 attempt 从已选定的稳定 checkpoint fork 到新 namespace；旧 Worker 即使继续写，也只能污染旧 namespace。业务表保存当前授权 attempt/checkpoint pointer，pointer 更新必须 fenced。
9. PostgresSaver adapter 上线前必须验证 namespace fork、pending writes、interrupt/resume、serializer/version、TTL/删除级联和 payload 上限。Iteration 0010 只固定这一设计，不把它伪装成已经实现的 checkpoint fencing。
10. 真实 PostgreSQL 多连接测试是 claim/event/effect 协议的退出门槛；PGlite 继续承担快速 migration/repository 回归，但不能替代 row-lock 等待、READ COMMITTED recheck 与独立 backend session。
11. 本 ADR 细化 ADR-0010 的“数据库权威时间”：lease expiry、续期和授权判断使用 PostgreSQL `clock_timestamp()`，不能使用会冻结在事务起点的 `now()`。需要等待 job row lock 的写入必须先取得锁，再以当前 wall clock 重检 lease；一旦重检通过，该事务持有的 row lock 会阻止 takeover 并发提交。

## 不变量

- 一个 job-scoped effect/event key 只能代表一个稳定 request/payload；
- takeover 后旧 token 不能追加 event、完成 effect 或改变当前 checkpoint pointer；
- event seq 在成功提交的 event 之间连续，幂等重放不消耗新 seq；
- 未知外部结果保持 `uncertain`，不能被自动当作成功或安全重试；
- checkpoint 恢复点与当前 run authorization 分离，但只能由 fenced pointer 把二者连接；
- terminal event 与 terminal job/run 状态最终必须同事务提交。

## 结果

- 已实现的 job/run/event/effect repository 路径在重复投递与 Worker takeover 时不再只依赖“调用方记得别重复”这一约定；checkpoint replay 只有在 PostgresSaver adapter 与 fenced pointer 落地后才获得同等保证；
- event、tool/model/search 与 export 可以共享一套授权和幂等语义，同时保留各 adapter 的恢复策略；
- `run_effects` 保存 bounded metadata，不默认持久化完整 prompt、正文、tool output 或敏感 provider payload；
- crash window 被显式表示为 `uncertain`，工程上可观测但不会被包装成 exactly-once。

## 未选择

- 只靠 BullMQ job id：它不能授权数据库写入，也不能覆盖手工 resume 或其他投递来源；
- 只在 effect 前调用 heartbeat：授权与副作用之间仍有 takeover 窗口；
- 所有副作用放进 LangGraph node 后相信 checkpoint：外部调用和 checkpoint 不是原子事务；
- 新 attempt 继续复用旧 checkpoint namespace：zombie Worker 可以污染恢复点；
- 对所有 `uncertain` 自动 retry：没有 provider idempotency 时可能重复计费、重复发布或覆盖文章。
