# ADR-0003：PostgreSQL 作为持久化业务真相

- 状态：Accepted
- 日期：2026-08-07

## 背景

当前 JobStore、SSE history 和取消状态在 Python 内存中，文章默认保存在本地 SQLite 和 Markdown 文件。多实例、重启恢复、memory 和 eval 都需要统一持久化边界。

## 决定

使用 PostgreSQL + Drizzle 保存 job、event、article、memory 和 eval 业务状态；LangGraph 使用 PostgreSQL checkpointer。Redis/BullMQ 和 Langfuse 都是可重建的派生/执行基础设施，不是唯一真相。

## 结果

- 数据结构变化必须使用 migration；
- job 与 queue 通过 transactional outbox 协调；
- SSE 事件必须持久化并按 `job_id + seq` 唯一；
- pgvector 可以作为初期 memory/RAG 语义检索实现；
- 需要制定旧 SQLite 数据迁移策略。

## 未选择

- 继续使用生产 SQLite：不适合计划中的多实例和 Worker 架构。
- 只把状态放 Redis：不利于审计、关系查询和长期保留。
