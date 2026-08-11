# ADR-0042：Fenced Memory Extraction Effects

- 状态：Accepted
- 日期：2026-08-07

## 背景

Memory extraction 在 source run 已完成后异步执行，不能复用依赖 active job/run lease 的 `run_effects`。BullMQ lock 只能约束队列消费，不能授权数据库写入，也不能回答“provider 可能已收费成功，但 Worker 在记录结果前崩溃”是否可以重试。直接依靠 candidate unique key 去重仍可能重复调用收费模型。

## 决定

1. 每个 completed source run最多建立一个 `memory_extraction_tasks`。首次 claim 固定 extractor、prompt、consent/retention和model profile execution snapshot及其fingerprint；后续attempt不得静默漂移配置。
2. Worker必须以数据库时钟claim task。每次claim追加`memory_extraction_attempts`并取得随机lease token；heartbeat只允许当前未过期token续租。两个消费者并发领取同一source时只有一个获得调用权。
3. provider调用前必须在当前lease下创建`memory_extraction_effects` reservation。effect key包含attempt序号，请求fingerprint只使用run、evidence fingerprint和版本化执行身份，不保存topic、正文、prompt或模型输出。只有本次新建的`reserved`结果允许调用provider；`already_reserved/succeeded/failed/uncertain`均fail closed。
4. 明确失败且provider adapter声明调用未成功时，effect记为`failed`，可在attempt预算内用新attempt重试。未知网络结果会把effect与task/attempt记为`uncertain`；已记录`succeeded`的effect保留成功证据，但其后发生lease过期或candidate持久化失败时task/attempt仍转为`uncertain`，禁止自动再次收费。provider身份不匹配同样fail closed。
5. effect只保存provider/model/request id、token usage、可选microusd定价身份、latency和bounded error。task只保存计数结果；三张表都直接携带workspace id并启用RLS。
6. terminal/uncertain错误在BullMQ adapter中转为unrecoverable。真实provider仍需版本化prompt、hard cost budget和extractor quality calibration后才能启用；本ADR只建立安全调用边界，不授权production consumer。

## 结果与限制

队列仍是at-least-once delivery，但provider执行获得独立的DB lease与effect reservation。系统对未知结果选择停止并等待人工或专用resolver，而不是用重复扣费换取自动收敛，因此不宣称exactly-once。当前没有保存模型原始输出，succeeded effect后若candidate提交未完成只能进入reconciliation；未来若要自动恢复，必须新增加密、retention-bound result store或provider result resolver，并通过新的ADR决定。

迁移是纯新增表。回滚运行时只需保持Memory consumer关闭；已有ledger可保留用于审计，不需要删除或改写candidate数据。
