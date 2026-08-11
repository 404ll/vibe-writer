# Iteration 0013：Durable Workflow 与 Terminal Transaction

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker cutover
- 对应决策：[ADR-0014](../decisions/0014-durable-workflow-executor-and-terminal-transaction.md)

## 目标

把 BullMQ/lease runner、Postgres checkpoint 和 TypeScript workflow 组装起来，并用一个 fenced PostgreSQL transaction 提交 article、job/run terminal 与 terminal event。

## 范围内

- article/article_version schema、migration 与生成态 repository；
- completed/failed/cancelled terminal transaction；
- `done.output_path` nullable compatibility widening；
- executor result protocol：completed/awaiting-input/failed；
- PostgresSaver terminal replay → idempotent article commit；
- duplicate delivery、takeover、crash-window 与 terminal event tests；
- ADR、Eval、系统设计与验证记录。

## 范围外

- 不切 Next.js jobs/articles/SSE route；
- 不接真实 Anthropic/Tavily provider；
- 不完成 outline reply API/requeue，只固定 awaiting-input executor 边界；
- 不实现对象存储 artifact、全文搜索、memory/RAG 或线上 eval；
- 不删除 Python/FastAPI。

## 必须证明的行为

1. completed transaction 原子写 article、done event、job/run terminal 并清 lease；
2. 同一 export replay 返回相同 article/event，不同 fingerprint collision；
3. stale/expired token 不写 article或 terminal；
4. failed/cancelled 原子写对应 terminal event且不写 article；
5. terminal event seq 与既有 progress event 连续；
6. terminal checkpoint 后、业务 commit 前崩溃可由新 run replay，组件不重复；
7. duplicate BullMQ delivery 只产生一个 article/terminal event；
8. executor 识别 interrupt 为 awaiting-input，不 settle completed；
9. output path nullable 同时接受 Python string 与 TS null；
10. 全仓 verify、真实 PostgreSQL/Redis、migration/docs/diff check 通过。

## 实现结果

- 新增 `articles` / `article_versions` schema、Drizzle migration、内容 fingerprint、run/config provenance 和生成态唯一约束；TS 完成事件使用 `output_path: null`，共享契约仍接受 Python 的字符串路径。
- `TerminalRepository` 提供 `completeClaim()`、`terminateClaim()` 与 `pauseClaim()`：全部锁定 job、校验 run/token/DB-time lease，再同事务提交 article 或对应 event、job/run 状态、连续 seq、lease 清理和 reserved effect uncertainty。
- `WorkerExecutor` 从 `Promise<void>` 改为 `completed(exportIntent) | awaiting_input(outline) | failed(code/message)`；`WorkerJobRunner` 不再把“函数返回”直接等同于 completed。
- `DurableWorkflowExecutor` 组装 `WorkflowServices`、LangGraph、fenced checkpoint attempt 与 run execution snapshot；已有 checkpoint 时 replay，fresh run 才创建初始 state。unsupported interrupt、非法 state 和 graph failure 都转为受限的结构化结果。
- outline interrupt 投影为 `awaiting_input + outline_ready` 并释放执行 lease，不会创建 article 或 done；完整 reply/requeue API 仍留到后续迭代。
- terminal checkpoint 与业务终态之间的 crash window 已由 takeover test 固定：新 run fork/replay terminal checkpoint，Planner/Writer 不重复调用，只提交一个 article/done event。
- BullMQ duplicate/stalled/cancel 路径已切到新的 terminal control；Redis 仍只保存 job pointer，业务正文和终态只读 PostgreSQL。

## 验证证据

- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model runtime 9、agent core 92、workflow 47、DB 40、checkpoint 8、worker 33、Python API 50，migration/typecheck/lint/Web test/build/docs 全通过（依赖重建后复跑）。
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 7/7、PostgresSaver 4/4；覆盖多 session terminal winner/replay、lease fencing 和 checkpoint。
- `pnpm test:worker:redis:local`：真实 Redis/BullMQ 7/7；覆盖 deterministic dedupe、DB duplicate claim、outbox chain、retry/unrecoverable、cancel、stalled redelivery 和 graceful shutdown。
- `git diff --check` 通过；临时 PostgreSQL 已停止，`vibe-writer-redis-*` 临时容器无残留。

## 遗留边界

- Next.js jobs/articles/SSE 仍未切到 PostgreSQL，当前产品流量继续走 FastAPI/SQLite。
- 尚无真实 Anthropic/Tavily adapter、provider idempotency/result resolver、生产 Worker/dispatcher supervisor。
- awaiting-input 只完成 executor/repository 边界，reply command 持久化和 requeue 尚未实现。
- 旧 `JobRepository.settleClaim()` 保留给前序协议测试和迁移兼容；新 Worker 只通过 terminal repository 提交业务终态，切流前应移除或收窄旧入口。

## 回滚

当前产品仍走 FastAPI/SQLite。新表和 executor 未切流；若 migration 已应用，使用 forward compensating migration，不能改写共享环境历史。
