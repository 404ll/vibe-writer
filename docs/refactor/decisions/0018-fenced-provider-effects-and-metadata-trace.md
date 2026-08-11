# ADR-0018：Provider Effect 围栏与最小元数据归因

- 状态：Accepted
- 日期：2026-08-07

## 背景

`run_effects` 已能 reserve/finish/uncertain，Anthropic/Tavily adapter 与 production Worker 也已组装，但二者此前没有接线。模型或搜索可能在 Worker 丢 lease、进程崩溃或 checkpoint 尚未提交时已经产生费用和外部结果；只记录 graph checkpoint 无法表达这段副作用窗口。另一方面，直接持久化 prompt、完整响应和搜索文档会把用户正文与供应商 payload 扩散到新的数据面。

## 决定

1. Worker composition 在每个 run 创建 `EffectJournalModel` 和 `EffectJournalSearchProvider`；journal 身份固定为 `job_id + run_id + lease_token`，Agent core、workflow runtime 和 provider adapter 不直接依赖数据库。
2. graph 为每个可调用 provider 的节点生成确定性 `effectScope`，包含节点、章节、业务 attempt；tool model 再增加 request ordinal，search tool 增加 tool/round/call。effect key 在 job 内稳定，不能使用随机 UUID。
3. 外部调用前必须成功 reserve canonical request fingerprint；只有 `reserved` 允许发请求。`already_reserved`、`previously_succeeded`、`previous_failed`、`uncertain`、cancel 和 lease lost 全部 fail closed。
4. 成功后只保存 provider、model、request id、usage、stop/finish reason、latency 或 document count。prompt、messages、tool arguments/results、响应正文、query、URL 和 snippet 只参与内存执行或 request fingerprint，不进入 `result_metadata`。
5. provider 失败先用 bounded code/message 完成 journal，再把原错误交给上层策略；不得把原始响应或 secret 写入 journal。
6. finish 也必须持有原 lease。provider 已成功但 finish 因 lease lost/crash 失败时，调用方失败，reservation 由 takeover/terminal 变成 `uncertain`，不得伪装成成功。
7. `DurableWorkflowExecutor` 接受 per-run service factory，使 provider wrapper 的 lease identity 不会被跨 run 复用。
8. 当前 journal 是业务副作用审计与恢复门禁，不是完整 trace backend。未来 observability adapter 可消费同一 bounded metadata，但原文采样必须另有 consent、脱敏、访问控制和 retention 决策。

## 不变量

- 没有有效 lease reservation，就不能开始新的外部 provider 请求。
- 一个 job-scoped effect key 只能对应一个 canonical request fingerprint。
- journal 不保存 prompt、文章正文、搜索 query/URL/snippet 或 provider secret。
- checkpoint replay 不会因为 effect 曾被调用就自动重放外部副作用。

## 明确限制

本方案不提供 exactly-once。`previously_succeeded` 只有 bounded metadata，没有足够内容重建模型或搜索结果；`uncertain` 也无法判断供应商是否已完成。引入 provider idempotency/read API、持久化可恢复结果或人工 resolver 之前，这些状态必须停住并显式处理。

## 未选择

- reservation 失败后继续 best effort 调用：会绕开 lease fencing。
- 对 `uncertain` 或 `previous_failed` 自动 retry：可能重复计费或得到不同正文。
- 把完整 transcript 存进 `run_effects`：会把业务 journal 变成无限增长的敏感 trace store。
- 让 Agent service 自己写数据库：会污染 provider-neutral 领域边界并使组件 eval 难以隔离。
