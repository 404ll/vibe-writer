# ADR-0007：Search 使用供应商无关端口并保留结构化来源与失败语义

- 状态：Accepted
- 日期：2026-08-07

## 背景

Python `SearchAgent` 同时负责查询分类、Tavily client 初始化、同步 SDK 的线程池调用、日期排序、摘要拼接和 LLM 提炼。调用失败、缺少 API key 与无结果分别被压成空字符串或中文提示，Writer 因而无法可靠地区分“没有证据”“工具不可用”和“搜索成功”。搜索摘要还丢弃 title/URL，后续无法做引用检查、来源质量 eval 或 provenance 审计。

`OpinionAgent` 的名字也与当前 prompt 不一致：它生成的是章节客观覆盖点和对应搜索方向，并非个人观点。其两个平行数组可以长度不等或包含非法成员，错误会静默传播到 Writer。

Tavily 当前官方 Search API 支持 `topic`、`search_depth`、`max_results`、`start_date`/`end_date` 和来源的 title、URL、content、score；`days` 仅适用于 news topic。其官方生产建议还强调使用 score 过滤和 async client 提升吞吐。供应商契约会继续变化，因此这些 SDK 类型不应成为 Agent 领域契约。参考 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) 与 [Search best practices](https://docs.tavily.com/documentation/best-practices/best-practices-search)。

## 决定

1. 将 Python `Opinion` 概念在 TS 领域层命名为 `CoveragePlannerService`。模型输出仍读取 compatibility 字段 `opinions` / `search_queries`，但立即转换为成对的 `CoveragePoint { text, searchQuery }`。
2. Coverage output 必须是 1–3 个非空、等长的覆盖点与查询数组；非法 JSON、非法成员、空数组或长度不等返回 `inconclusive`，不能伪装为可用计划。
3. `packages/contracts` 定义供应商无关的 `SearchRequest`、`SearchDocument` 和 `SearchProviderResponse`。`SearchDocument` 保留 title、URL、content、publishedAt 和可选 score。
4. `packages/agent-core` 定义窄 `SearchProvider` port。核心包不导入 Tavily SDK；未来 Worker adapter 负责配置、超时、重试、供应商字段映射和 response schema 校验。
5. 查询策略使用注入 clock 计算确定性日期上下界：时效查询为 `asOf-90d → asOf`，一般技术查询为 `asOf-365d → asOf`；单一或全部处于过去的明确年份使用最早年份 `01-01 → 最晚年份 12-31`；历史/当前或历史/未来对比使用最早历史年份 `01-01 → asOf`，不请求 as-of 之后的来源。通用 `startDate/endDate` 避免把 news-only `days` 参数错误用于 general topic，也避免回放时混入未来来源。
6. `publishedAt` 只接受 ISO date 或带时区的 ISO datetime。排序规则显式为：过滤 endDate 之后的来源；有合法发布日期的来源优先、日期越新越前；同日期或无日期时再用 provider score 和原始顺序。旧 Python 中“无日期结果可能排在很旧但有日期的来源前”作为 intentional delta 记录。
7. `ResearchService` 是查询策略、provider 调用、排序和模型提炼的全流程 orchestrator。`SearchProvider` 以抛出的 `SearchProviderError` 表达 typed infrastructure failure：auth/unavailable → unavailable；rate_limited/timeout/invalid_response/provider_error → failed，并保留 stage/reason/retryable 和可用的 provider/request id。模型调用错误映射为 `failed { stage: distillation, reason: model_error, retryable, modelErrorCode }`。只有 provider/model 明确给出 `cancelled`、标准 `AbortError` 或未分类错误同时伴随外部 signal aborted 时才继续抛给 cancelled 路径；typed timeout 即使内部使用 abort 实现也仍是 timeout failed。
8. Research prompt 在调用时注入 `asOfDate`，不在模块 import 时冻结日期；prompt 需要保留来源序号，输入包含 title、URL、发布时间和摘要。
9. 搜索原始 content 只用于当前 research 调用。当前组件以来源 URL 作为稳定引用；未来进入自有 source/RAG 表时再分配内部 source id。默认 trace/persistence 保存 query policy、provider/request id、URL/title/日期、hash、usage 与错误；全文 snippet 若需进入 eval dataset，必须显式采样、去标识化并设置保留策略。

## 结果

- 未来 Writer/tool loop 接线后可以基于状态决定重试、降级或终止，不再解析中文错误字符串；具体策略尚未实现；
- 接口层不绑定 Tavily，Coverage/Research component eval 可注入 scripted provider；运行时可替换性仍需真实 adapter 集成测试；
- 来源 URL 与时间被保留，可支持 citation grader、来源新鲜度和未来 RAG ingestion；
- clock、prompt version、provider request id 和 AbortSignal 都有稳定注入点；
- Python compatibility 与 TS target 的安全/可追溯性差异进入共享 dataset。

Coverage 的 inconclusive 在本层只保留原因；有限重试、降级还是终止必须在组图迭代形成显式策略，本 ADR 不预先决定。

## 未选择

- 在 Agent core 直接使用 Tavily SDK/AI SDK tool：实现更短，但供应商参数、错误和返回 shape 会进入长期领域边界。
- 所有失败继续返回空字符串：兼容旧 Writer，却无法区分业务无结果和基础设施故障。
- 只保留 LLM 提炼后的文本：存储更少，但无法做引用、来源质量和 research regression eval。
- 本迭代实现真实 Tavily adapter：在 Writer/tool loop 与 Worker 组装之前无法验证 timeout/retry/trace 的运行时策略；本轮先固定端口与无网络 component eval。
