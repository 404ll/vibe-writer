# ADR-0046：Typed Memory Extraction Delivery and Source Erasure Fencing

- 状态：Accepted
- 日期：2026-08-07

## 背景

ADR-0045已经把proposal/candidate evidence升级为严格`run | signal` source，但extraction task/attempt/effect、outbox和BullMQ仍以run id为唯一身份。若直接把signal正文放进消息，会扩大Redis中的敏感数据副本；若signal在provider调用期间被删除，又可能出现正文已擦除、收费调用仍完成、账本却被级联删除或误判为可重试的情况。

## 决定

1. extraction task使用稳定`source_id`作为主键，并显式保存`source_kind`。active row只能引用匹配的`source_run_id`或`source_signal_id`；attempt/effect统一引用`source_id`，不再假设来源必为run。
2. run引用维持级联语义；signal引用使用`ON DELETE RESTRICT`。删除signal前必须在同一数据库事务中settle extraction，再清除引用，避免数据库悄悄删除收费调用审计。
3. 已擦除signal的task保留`source_id/source_kind/source_deleted_at`和content-free attempt/effect metadata，但清空`source_signal_id`。数据库check要求detached row必须为`completed | failed | uncertain | cancelled`终态。
4. 删除发生在queued或provider reservation之前时，task/当前attempt进入`cancelled`；已存在`reserved | succeeded | uncertain` effect时，task/attempt进入`uncertain`，仍为reserved的effect也转为`uncertain`。删除事务撤销lease，迟到的heartbeat/finish只能得到`lease_lost`，不能覆盖终态。
5. terminal run和explicit signal都在来源事务中写入v2 outbox：`{schemaVersion:2, source:{kind,id}}`。BullMQ沿用pointer-only消息，并以`memory-run-{id}`或`memory-signal-{id}`去重；正文只由Worker在数据库claim后加载。
6. consumer严格解析v2 tagged union；只为已投递的精确v1 run envelope保留兼容升级。未知版本、多余字段、无效UUID或source/aggregate不一致均不可恢复地拒绝。
7. signal trusted subject、evidence、explicit consent和retention由repository重新加载，Worker只把signal文本标为`user/durable`。模型返回的subject不能覆盖trusted envelope。

## 结果与限制

run与signal现在共享同一套durable delivery、lease、effect fencing和content-free计量；signal撤回不会抹掉收费调用证据，也不会让迟到provider结果重新激活任务。Redis只保存source pointer，不保存topic、article或signal文本。

这仍不是production Memory开关。没有HTTP/UI consent入口、production consumer、expiry scheduler、reconciliation操作面、真实模型质量/成本校准、embedding或retrieval assembly。

## Migration 与回滚

migration先将attempt/effect的`source_run_id`重命名为`source_id`，再为task增加nullable `source_id/source_kind/source_signal_id/source_deleted_at`，以旧`source_run_id`回填`source_id`后设置非空主键，最后增加typed外键、partial unique index和source check。现有run账本身份与审计元数据不变。

回滚前必须停止v2 producer/consumer，并确认不存在signal task或detached ledger；否则降回run-only会丢失signal effect审计。已擦除signal正文不能通过回滚恢复，`uncertain`记录必须先由reconciliation处理，不能盲目重放。
