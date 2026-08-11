# Anthropic Messages 能力审计：2026-08-07

- 审计日期：2026-08-07
- 范围：同步 Messages API 的调用身份、terminal lookup、usage report 与 Message Batches result
- 结论：不具备自动处理同步调用 `uncertain` outcome 所需的 request-level terminal evidence；Memory production extraction 保持 No-Go

## 官方证据

1. [Errors 文档](https://platform.claude.com/docs/en/api/errors)说明每个API响应都带唯一的HTTP `request-id` header，SDK也暴露`_request_id`。这与Messages JSON body中的Message object `id`不是同一个字段。
2. [Messages API reference](https://platform.claude.com/docs/en/api/messages)当前列出Create a Message与Count tokens，没有文档化按同步Message/request id读取terminal结果的操作。因此“同步调用不可查询”是基于当前官方API目录的保守推断，不是对未来能力的永久断言。
3. [Messages usage report](https://platform.claude.com/docs/en/api/admin/usage_report/retrieve)按时间、workspace、API key、model、service tier等维度聚合；当前文档没有request-id分组或过滤维度。它可用于聚合成本对账，不能单独证明某个uncertain请求的terminal状态。
4. [Message Batch results](https://platform.claude.com/docs/en/api/messages/batches/results)只适用于batch execution；不能把batch结果查询能力外推到同步Messages调用。

## 工程决策

- `request-id`保存为`providerRequestId`；Messages JSON object `id`保存为`providerResponseId`，禁止互相冒充。
- 当前不注册Anthropic同步Messages lookup adapter；`uncertain` effect继续hold，不能因为`not_found`、usage aggregate或Message object id而自动重试。
- calibration runner必须同时捕获HTTP request id、response object id、usage与固定pricing snapshot；任何缺失都使trial不具备production evidence资格。
- 只有后续官方能力审计确认request-level terminal lookup，或建立经验证的替代证据链，才可修改`automaticUncertainResolutionEligible=false`。

## 复审触发器

- Anthropic新增Get Message、request status或request-level usage/cost endpoint；
- execution transport从同步Messages改为Message Batches；
- 引入可按request id核验的网关/代理，并证明其幂等、保留和鉴权边界；
- calibration target、model或pricing snapshot发生变化。
