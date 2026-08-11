# ADR-0048：Owner-controlled Memory Extraction Reconciliation

- 状态：Accepted
- 日期：2026-08-07

## 背景

Memory extraction对provider unknown outcome、source erasure after reservation、usage缺失和post-provider persistence failure统一fail closed为`uncertain`。这能阻止重复收费，但若没有受控resolution，预算预留会永久占用，任务也只能人工改数据库。直接把`uncertain`重置成queued同样不安全：provider可能已经成功，重放会重复收费并生成相互冲突的Memory候选。

## 决定

1. reconciliation只接受两种已证明的外部结论：`confirmed_failed`或`confirmed_succeeded`。证据来源显式标记为provider lookup、billing export或operator attestation，并只保存SHA-256 fingerprint、provider request id和content-free metering，不保存provider原始响应。
2. 只有workspace owner可以执行或读取reconciliation。repository必须设置workspace DB session，append-only `memory_extraction_reconciliations`表启用RLS；editor/viewer无权提交决策。
3. 每个effect最多一个resolution；workspace idempotency key与完整resolution fingerprint共同保证精确重放。相同请求返回replayed，不同请求碰撞直接拒绝。task、attempt、effect在同一事务内按固定顺序加锁。
4. resolution只接受task、attempt、effect三者均为`uncertain`的状态。它不是通用状态编辑API，不能改写running、failed、completed或cancelled执行。
5. `confirmed_failed`把effect/attempt改为failed。owner可选择hold，或显式提供1–10的`maxAttempts`进行有界requeue；requeue仅在当前attempt未耗尽且source仍存在时允许。
6. `confirmed_succeeded`把effect结算为succeeded，但当前系统没有retention-bound provider result store，无法重建模型输出。因此attempt/task以`reconciled_result_unavailable`终结为failed，禁止requeue或再次调用provider。
7. budgeted effect的任何resolution都必须提供usage与cost evidence，并匹配原reservation pricing snapshot。confirmed failure按已证明的实际cost释放或结算预留；confirmed success按实际cost占额，即使实际费用高于原预留也必须如实记录。
8. signal已经擦除后仍可hold并结清审计，但不得requeue。来源删除权优先于任务恢复。

## 结果与限制

`uncertain`现在有了显式、权限化和可重复审计的出口，同时仍保持“未知不自动重试”。运维可以安全释放已证明未成功的调用，或结算已成功但结果丢失的费用；不能用reconciliation注入Memory正文或伪造候选。

当前没有provider-specific lookup adapter、账单导入任务、HTTP管理API、双人审批或告警SLO。operator attestation是高权限证据类型，未来生产启用前应增加组织级审计和可选双人复核。

## Migration 与回滚

migration新增append-only reconciliation表、effect唯一约束、workspace幂等约束、外键和RLS，不改写历史effect。回滚前必须停止resolver写入并导出审计；删除该表会丢失是谁基于何种证据释放预算或授权重试的信息，不能仅凭effect终态重建。
