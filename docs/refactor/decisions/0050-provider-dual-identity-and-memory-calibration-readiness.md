# ADR-0050：Provider Dual Identity 与 Memory Calibration Readiness

- 状态：Accepted
- 日期：2026-08-07

## 背景

Anthropic同步Messages响应同时存在HTTP `request-id`和JSON Message object `id`。旧adapter把后者写进`requestId`，会让trace、Eval计量和Memory effect ledger错误地把response identity当成transport request identity。另一方面，Iteration 0048只建立provider-neutral lookup协议；在没有确定model、pricing和真实trial以前，直接接入付费runner或production consumer会绕过质量、成本与unknown-outcome门禁。

## 决定

1. provider response contract显式区分`requestId`与`responseId`。Anthropic adapter只从HTTP `request-id` header填充前者，只从Messages JSON `id`填充后者；header缺失时不得用Message id补位。
2. trace span、Eval score metering、Memory extraction effect和reconciliation audit分别持久化`provider_request_id`与`provider_response_id`。reconciliation对两种identity独立执行collision检查，防止证据串单。
3. schema migration只增加nullable response identity，保留旧记录兼容；新的完整调用路径应尽可能同时记录两种identity，但不能伪造缺失值。
4. 真实Memory calibration使用tracked manifest固定dataset fingerprint、prompt/extractor版本、三次trial、精确call inventory、content capture关闭和quality gates。manifest没有model、pricing或cost cap时必须是`planned + productionEligible=false`。
5. readiness checker保持offline：只读取版本库中的manifest与baseline，不读取环境变量、不连接provider、DB或queue，也不发起付费调用。
6. 官方能力审计是版本化工程证据，不是永久事实。当前同步Anthropic Messages没有文档化request-level terminal lookup，usage report是aggregate-only，batch result只适用于batch；因此automatic uncertain resolution保持禁用。

## 结果与限制

trace、Eval和Memory ledger现在能正确关联transport请求与provider response object；缺少HTTP request id的响应不会被伪装成可查询请求。`pnpm eval:memory-calibration`提供可重复的No-Go门禁，清楚列出model、pricing、live trials和terminal lookup四个blocker。

本ADR不选择付费模型、不绑定实时价格、不执行真实trial、不实现Anthropic同步lookup adapter，也不启用production Memory consumer。质量gate当前只来自确定性24-case baseline，不代表任何真实模型通过。

## 回滚

可停止写入新的response identity并移除offline readiness命令，但已持久化的identity和migration不得破坏性删除。不得回滚到用Message object id冒充HTTP request id的语义。
