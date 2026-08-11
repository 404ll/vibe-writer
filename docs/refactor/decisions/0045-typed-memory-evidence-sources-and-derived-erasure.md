# ADR-0045：Typed Memory Evidence Sources and Derived Erasure

- 状态：Accepted
- 日期：2026-08-07

## 背景

ADR-0044建立了显式user-authored durable signal，但Memory proposal和candidate仍只认识completed run。若只在Worker里把signal文本拼进模型prompt，落库结果会失去可验证的source identity；用户撤回signal后，candidate、active Memory和revision也可能继续保留派生正文。

同时把task/attempt/effect ledger和BullMQ envelope一起迁移会改变收费调用的幂等身份、lease fencing、effect replay和消息兼容性。该范围需要独立故障矩阵，不能附带在proposal schema变更中完成。

## 决定

1. `MemoryProposal`升级为schema v2，source使用严格tagged union：`run`携带`runId`，`signal`携带`signalId`，两者都携带evidence fingerprint。未标记的legacy shape直接拒绝，不猜测source kind。
2. trusted extraction envelope使用同一source union；现有completed-run Worker只构造`kind=run`，不改变当前队列行为。
3. `memory_candidates`保存`source_kind`和互斥的`source_run_id/source_signal_id`。数据库check保证恰有一个source，run/signal分别使用partial unique index维持extractor slot幂等。
4. signal proposal落库前必须重新读取source row，并验证workspace、subject、evidence fingerprint、`explicit_user` consent policy、database-time retention和proposal expiry。调用方不能靠JSON伪造这些trusted facts。
5. `source_signal_id`以`ON DELETE CASCADE`引用signal。candidate是active Memory的current source，因此删除signal会由PostgreSQL级联清除candidate、candidate event、active Memory和revision；signal tombstone继续保持content-free。
6. policy identity提升为`2026-08-07-v2`，governance suite提升为v2，并增加合法signal source和拒绝untagged legacy source的tracked cases。v1 baseline保留为历史证据，不再作为当前gate。
7. 本轮不修改run-keyed extraction task/attempt/effect、outbox和BullMQ payload。它们继续只接受run；signal自动提取仍未启用。下一ADR必须一次性定义typed extraction identity、queue compatibility、effect idempotency和source erasure时的in-flight行为。

## 结果与限制

Memory proposal/candidate现在可以明确证明来自run或显式signal，source撤回不依赖应用进程执行best-effort清理。已有run candidate通过migration默认值保持`kind=run`，读写路径仍可重放。

这不是完整的signal extraction delivery。没有signal-keyed task、attempt、effect或queue message，也没有HTTP/UI入口、production consumer、embedding/cache。因此当前只能由受控调用者提交signal proposal，不能宣称“用户点击记住后会自动提取”。

## Migration 与回滚

migration先放宽旧`source_run_id`、以`run`回填`source_kind`，再增加signal外键、partial unique index和互斥check，现有run candidate无需重写。回滚必须先确认没有signal candidate，再将所有row约束回run-only并同步回退policy/schema消费者；直接删除signal source会有意级联清除派生正文，不能通过schema rollback恢复。
