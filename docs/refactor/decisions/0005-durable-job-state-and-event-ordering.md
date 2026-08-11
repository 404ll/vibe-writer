# ADR-0005：持久化 Job 状态、事件序号与 Outbox 不变量

- 状态：Accepted
- 日期：2026-08-07

## 背景

当前 Python `JobStore` 使用进程内字典保存任务、取消标志和 SSE history，并用当前事件数组长度产生 `_seq`。这种实现不能跨进程恢复，也无法在多个 Worker 并发写入时保证事件顺序。新数据层必须先定义可以由数据库证明的边界，再迁移 API 或 Agent。

## 决定

1. `jobs.status` 表示执行生命周期：`queued → running ↔ awaiting_input → completed | failed | cancelled`；`jobs.stage` 只表示 `plan | write | review | export`，不得用 stage 代替终态。
2. 每个 job 保存 `next_event_seq`。追加事件时先在事务内原子递增该字段，再把旧值写入 `job_events.seq`；`PRIMARY KEY (job_id, seq)` 是最终防重约束。
3. job 创建请求必须携带持久化 `idempotency_key`。第一次创建同时写入 job 和 enqueue outbox；重复请求返回同一个 job，不产生第二条 outbox。
4. 队列投递使用 transactional outbox。Redis/BullMQ 可以重复消费，outbox 的 `idempotency_key` 和业务 repository 负责让业务效果不重复。
5. 所有状态变更使用带当前状态条件的更新。terminal job 的 repository transition 不允许回到非终态。
6. 主键使用 UUID，事件序号和 attempt 使用非负/正整数；时间统一使用 `timestamptz`。

## 数据库能证明什么

- job idempotency key、outbox idempotency key 唯一；
- 同一 job 的 event seq 唯一且非负；
- target words、attempt、version 和 event cursor 合法；
- terminal row 必须有 `finished_at`，非 terminal row 不得提前填写；
- lease owner 与 lease expiry 同时存在或同时为空。

状态转移是否合法依赖 repository 的条件更新和集成测试，不能只靠单行 `CHECK` 约束表达完整状态机。

## 测试边界

Iteration 0004 使用 PGlite 在 Node 中执行真实 PostgreSQL migration、约束和 repository 测试。PGlite 是 PostgreSQL WASM 测试引擎，不是生产运行时，也不能单独证明多连接锁竞争、网络故障或托管 PostgreSQL 差异。切流前必须再运行真实 PostgreSQL 的并发、lease 和 outbox claim 集成测试。

## 结果

- Next.js 与未来 Worker 共享 `packages/db`，但本迭代不让 Next API 接管现有 FastAPI 流量；
- DB event history 成为未来 replay 真相，Redis 只承担低延迟通知；
- LangGraph checkpointer 继续使用独立表，业务 repository 不读取其内部序列化结构；
- 多租户身份与 RLS 尚未决定，0004 不伪造隔离保证；引入 user/project namespace 前必须新增 ADR 和 migration。

## 未选择

- 用 `MAX(seq) + 1` 分配事件序号：并发时需要额外锁，容易产生重复；
- 用 Redis `INCR` 作为唯一序号真相：数据库重放与 Redis 状态可能分叉；
- 只依赖队列的 exactly-once：BullMQ/Redis 的投递语义不能替代业务幂等；
- 在第一版 schema 中直接加入 memory/eval/pgvector：这些实体需要独立策略和评测，不应与 durable job 基础混为一次迁移。
