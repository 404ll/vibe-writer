# ADR-0049：Provider-neutral Memory Request Lookup

- 状态：Accepted
- 日期：2026-08-07

## 背景

ADR-0048允许owner使用外部证据处理Memory extraction的`uncertain` effect，但证据仍需调用者手工整理。若直接把provider查询嵌入repository事务，会在网络等待期间持有数据库连接和锁；若把`not_found`、timeout或5xx解释为provider调用失败，又会重新引入盲目重试和重复收费风险。

## 决定

1. `provider-runtime`定义独立`ProviderRequestLookup`端口，输入固定provider、model和request id，输出只能是`succeeded | failed | pending | not_found`。terminal结果必须包含strict usage和content-free evidence fingerprint；契约不承载prompt、model output或provider原始响应。
2. `pending`和`not_found`都表示证据不足，不是`confirmed_failed`。adapter缺失、request id缺失、transport error、invalid response或identity drift同样不得修改effect、attempt、task或预算。
3. DB repository提供owner-only `prepareLookup`和`getLookupTarget`。target只暴露source pointer、effect id、provider/model/request id、source deletion状态和versioned budget snapshot，不暴露source正文或模型输出。
4. application service先读取target并结束数据库事务，再调用provider lookup，最后才调用reconciliation repository。最终事务仍按ADR-0048重新锁定并校验task/attempt/effect，不能把lookup前的快照当成写入授权。
5. terminal usage使用effect reservation时固定的pricing snapshot计算cost。adapter不提供或覆盖价格，避免查询时的当前价格改写历史预算语义；effect reservation必须在repository内校验完整budget policy与task execution snapshot一致，不能只复用相同version但替换费率。
6. confirmed failure默认hold。只有owner在本次操作中显式给出`requeue`和1–10的`maxAttempts`才可授权新attempt；已擦除source在provider查询前即拒绝requeue。
7. exact idempotency key如果已经有reconciliation audit，`prepareLookup`直接返回既有结果，不再次查询provider。confirmed failure重放若改变hold/requeue或max-attempt intent必须报collision；并发调用即使都完成lookup，最终repository唯一约束和resolution fingerprint仍只允许一条审计。
8. scripted adapter用于确定性测试。任何真实provider adapter必须证明其read/status API语义、鉴权、错误分类、evidence fingerprint和usage字段后才能注册；创建请求时返回的request id本身不等于具备可查询能力。

## 结果与限制

Memory uncertain resolution现在具备可替换的provider证据入口，并明确分开“查询失败”“尚未完成”“未找到”和“provider已确认失败”。网络调用不占用reconciliation事务，成本仍使用历史snapshot，服务级重放不会产生第二次provider查询。

当前没有安装Anthropic或其他付费provider lookup adapter，也没有HTTP管理端点、后台backlog scanner、账单导入、双人审批或告警。scripted证据只证明状态机和集成边界，不证明任何真实provider支持按request id查询，也不证明真实价格或模型质量。

## 回滚

本轮没有schema migration。可移除application service和lookup adapter而保留ADR-0048的人工reconciliation能力；不得删除已有reconciliation audit，也不得把回滚解释为允许重放`uncertain` effect。
