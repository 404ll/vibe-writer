# ADR-0014：Durable Workflow Executor 与 Terminal Transaction

- 状态：Accepted
- 日期：2026-08-07

## 背景

R4 已让 `workflow-runtime` 以纯 graph 生成 `ExportIntent`，R5 已建立 DB lease、effect/checkpoint fencing 与 BullMQ delivery，但这些组件尚未组装为真实 Worker executor。现有 Python `export_node` 依次写本地 Markdown、提交 SQLite article、再推送 `done`；任一步崩溃都可能留下文件、文章、任务终态和 SSE 历史不一致。

当前 TypeScript `WorkerJobRunner` 在 executor 返回后单独 `settleClaim(completed)`，也无法让 article、job/run terminal 和 `done` event 同事务提交。若 executor 自己先 settle，runner 的第二次 settle 又会把已完成任务误判为 lease lost。因此 terminal ownership 必须重新收口。

## 决定

1. `workflow-runtime` 继续是无数据库副作用的 graph。完成态只返回 schema-valid `ExportIntent`；文章写入、terminal event 和 job/run settle 由 Worker infrastructure 处理。
2. 新增 durable workflow executor，组装 `WorkflowServices`、`FencedCheckpointSaver` 和 graph。它根据数据库 job/run execution snapshot 创建初始 state；进程重建时从 active checkpoint attempt 恢复，而不是从 Redis payload 或内存继续。
3. `WorkerExecutor.execute()` 从 `Promise<void>` 演进为显式结果：`completed(exportIntent)`、`awaiting_input(interrupt)` 或抛出/返回结构化失败。runner 不再假定“函数返回就一定完成”。
4. 新增 fenced terminal repository transaction：锁定 job，校验 `job_id + run_id + lease_token + DB-time lease`，再一次性完成 article insert/replay、terminal job event、job/run terminal、reserved effect uncertainty 和 lease 清理。旧 Worker 不能插入文章或终结新 run。
5. completed transaction 以 `job_id` 唯一 article 和稳定 export idempotency key 幂等。相同 markdown/topic replay 返回同一 article/event；相同 key 不同 fingerprint 报 collision，禁止静默覆盖。
6. `failed` 与 `cancelled` 也必须在 settle transaction 中追加 `error`/`cancelled` terminal event。对外 error 只保存 bounded/sanitized code/message；provider 原始响应不进入 SSE。
7. article 是 PostgreSQL 内容真相。TS target 不把本地 `output/*.md` 当 durable artifact；`done.output_path` 契约宽化为 `string | null`，Python 仍可发送路径，TS 在没有对象存储 artifact 时发送 `null`。Web 只依赖 `article_id` 跳转。
8. `articles` 使用 UUID、`job_id` 唯一、保存 topic/content/word count/content fingerprint、source run/config version、revision/timestamps。`article_versions` 保存编辑前快照；初次 export 不伪造“编辑历史”。
9. article patch/restore 后续也必须以数据库 transaction 追加 snapshot 并使用 revision/optimistic concurrency；本迭代先保证生成完成事务，API edit route 切流可分步落地。
10. checkpoint 与 terminal transaction 仍是两个提交点：graph 先持久化 terminal checkpoint，随后提交业务终态。若两者之间崩溃，新 run 从 terminal checkpoint replay，不重复模型/工具，再幂等提交 article/terminal event。
11. outline interrupt 不能被当 completed。executor 返回 `awaiting_input`，repository 原子投影 awaiting state/event 并释放当前执行 lease；reply API 保存 command 后重新投递。完整 reply/API 切流属于后续迭代，但当前接口必须预留该结果而不是用异常模拟。
12. BullMQ completion 只表示 processor 结束；文章与任务是否完成只读 PostgreSQL terminal transaction。Redis 不保存 ExportIntent、正文或 terminal audit。

## 不变量

- 一个 completed job 恰有一个 article 和一个 `done` terminal event；
- article、job/run completed 与 done event 不出现半提交；
- failed/cancelled job 恰有对应 terminal event，不产生 article；
- terminal checkpoint 可早于业务 terminal，但业务 terminal 不能早于有效 export intent；
- stale run 不能写文章、terminal event 或清除当前 lease；
- 本地文件不是 TS target 的内容真相。

## 结果

- Worker 可以安全接入真实 graph，而不会在 queue ack、checkpoint、article 和 SSE 之间制造新的双写窗口；
- 终态事件可以由 durable SSE projection 重放；
- 后续 API 切流、memory/eval 可以引用稳定 article/run/config provenance。

## 未选择

- 保留 Python 式“写文件 → SQLite → SSE”：多实例不可恢复且三次写入不原子；
- executor 内写 article、runner 再 settle：仍是双事务并产生二次 settle；
- 把最终正文放进 BullMQ return value 作为真相：Redis retention/清理会丢业务数据；
- 收到 terminal checkpoint 就推送 done：article 可能尚未提交；
- 用 job id 覆盖已有不同文章：掩盖 idempotency collision。
