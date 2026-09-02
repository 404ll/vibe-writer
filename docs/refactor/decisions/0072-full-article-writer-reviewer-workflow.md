# ADR-0072：全文 Writer 与隔离 Reviewer 通过版本化 artifact 协作

- 状态：Accepted
- 日期：2026-09-03

## 背景

旧 Graph 把每章分别交给 Writer 和 Chapter Reviewer，最后再拼成全文。每个章节调用只能看到主题、大纲、当前章节要点和孤立反馈，导致用户指定的语气主要在正文阶段才出现、章节之间重复定义和转场断裂。Full Reviewer 虽然能看到全文，但返工只把单章字符串反馈交给新的章节调用，无法回到负责整篇叙事的同一个 Writer 上下文。

这不是跨任务长期 Memory 问题，也不需要让多个自治 Agent 自由聊天。需要的是当前任务内、可 checkpoint、可审计、受预算约束的编辑协作状态。

## 决定

1. 产品默认 Graph 提升为 `writer-reviewer-graph-v2-2026-09-03`，保留 `plan → outline_review`，确认后改为 `writer_agent → reviewer_agent → export | writer_agent`。
2. 一个 Writer Agent 对全文负责。它读取 `WritingBrief`、确认大纲、经过界定的大纲编辑决策，并在返工时继承 provider-neutral 的正常 message/tool transcript；不保存或请求 chain-of-thought。
3. Reviewer 每轮使用独立模型调用，只读取 brief、确认大纲、来源清单、当前完整草稿和 rubric。Reviewer 不接收 Writer session，也不直接改写正文，只返回严格的 `ReviewReport`。
4. Agent 之间只通过有 schema 和版本号的 artifact 协作：`WritingBrief`、`EditorialDecision[]`、`WriterSession`、`SourceNotebook`、`ReviewReport` 和完整 draft。
5. Reviewer 的 `needs_revision` 回到同一个 Writer session；第二轮仍未通过时导出当前稿并写入显式质量 warning，避免主观审核形成无限循环。
6. 空稿、缺少一级标题、缺少确认章节和篇幅硬上限继续由确定性代码检查，不消耗 Reviewer 调用。
7. Writer 可以使用既有 `ResearchFn/SearchProvider` 与 diagram tool；本决策不新增 Research Agent，也不改变联网 provider 或网页提取实现。
8. UI 只投影 `planning/composing/reviewing/revising/export` 等真实里程碑，不伪造模型思考或逐章生成过程。

## Checkpoint 与兼容策略

`WriterSession` 只保存 JSON 可序列化的普通消息、tool call/result 和累计 tool budget。SDK client、AbortSignal、连接对象、隐藏推理和供应商私有对象不能进入 checkpoint。

v1 与 v2 的 state shape、effect key 和执行语义不同，不做隐式迁移。checkpoint repository 已按不可变 `execution_config.graphVersion` 校验；Executor 在 replay 前还会比较 prompt set、model profile 和 toolset 语义版本。旧 v1 paused checkpoint 在 v2 Worker 上恢复会 fail closed，而不是套用新 prompt 静默续跑。`codeRevision` 只用于审计，不作为 hard gate，避免不改变这些语义版本的普通部署破坏 durable resume。部署 v2 前必须先排空 v1 运行中/等待输入任务，或明确取消后由用户创建新任务。

## 取舍

- 全文 Writer 比逐章调用需要更大的单次输出预算；因此使用 `articleDraftBudget` 硬上限，并只对 `max_tokens` 做一次有界 continuation。
- 持久化 Writer transcript 增加 checkpoint 内容和用户内容保留风险；因此消息数、单块字符、session 总字符、来源数量、编辑决策数和总工具调用都有 schema 上限。
- Reviewer 使用新鲜上下文能减少 Writer 自我辩护和确认偏差，但结构化报告可能遗漏细节；确定性检查和最多两轮闭环提供稳定终止语义。
- 当前 provider-neutral message contract 能表达普通文本与 tool call/result continuation，但不能恢复供应商内部隐式状态或隐藏推理。

## 回滚

回滚代码前先排空或取消 v2 checkpoint；旧 v1 runtime 同样不能安全读取 v2 state。随后恢复 v1 Worker composition 和对应 graph/prompt/tool/eval versions。已经导出的 Article 不受影响。
