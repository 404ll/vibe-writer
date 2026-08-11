# ADR-0008：Writer 使用供应商无关 ToolModel 与有界工具循环

- 状态：Accepted
- 日期：2026-08-07

## 背景

Python `BaseAgent._call_llm_with_tools()` 直接读写 Anthropic 的 `tool_use` / `tool_result` content block，最多进行 8 次模型请求；当轮次耗尽或最终文本为空时返回空字符串。Writer 另外由 graph wrapper 限制每次写作最多搜索 3 次。预算分散、错误被压成字符串、空结果没有终态语义，使迁移后很难判断一次写作究竟成功、失败还是只是不完整。

真实工具协议还要求每个 tool call 都有匹配的 result，并在下一条 user message 中紧跟返回；错误结果要显式标记。不同供应商的 block、finish reason 和续写行为并不相同，因此 Agent core 不能长期依赖 Anthropic SDK 类型。参考 [Anthropic tool use](https://docs.anthropic.com/ko/docs/agents-and-tools/tool-use/implement-tool-use) 与 [stop reason handling](https://docs.anthropic.com/pt/api/handling-stop-reasons)。

## 决定

1. `packages/model-runtime` 定义供应商无关的 `ToolModel`、message block、tool definition、stop reason、usage 和 request metadata。未来 adapter 负责在领域 block 与具体供应商协议之间双向转换，并校验 response；`packages/agent-core` 不导入 Anthropic、LangChain 或 AI SDK 类型。
2. 每个注册工具只提供 name、description 和一份严格 Zod input schema；`ToolLoopRunner` 统一由它生成暴露给模型的 JSON Schema，类型上不再允许另传第二份 schema。memory、retrieval、grader 等后续能力必须按 graph stage 使用独立注册表和版本化 toolset，不能自动暴露给 Writer。toolset 和 Writer prompt 都使用显式版本。
3. `ToolLoopRunner` 保证 assistant tool calls 后立刻追加一条包含全部对应 tool results 的 user message，保持调用顺序和 call id。一轮中的空 id、重复 id、跨轮重复 id、`tool_use` 却没有 call、非 `tool_use` stop reason 却携带 call 都视为非法模型响应。
4. 每次 write attempt 默认最多 8 个工具轮次；每章最多允许 dispatch 8 个工具 call，search 另有每章 3 次预算。`ToolBudgetUsage` 是 Writer 的必需输入并随结果返回，graph/checkpoint 必须在重写和 retry 间传递。模型仍可能在一轮产生超过预算的 attempted calls；超出部分不执行 handler，但会逐个返回 `budget_exceeded`，因此 execution record 数可以大于 dispatch 上限。非法、未知和失败 call 也消耗总预算，避免错误重试绕过上限。8 个工具轮次后允许一次仅用于生成最终文本的模型请求；若它再次请求工具，则以 `max_tool_rounds` 结束。这是对旧 Python “第 8 次请求执行完工具后直接返回空字符串”的 intentional delta。
5. 未知工具、非法参数、工具业务错误、handler 异常和预算耗尽都生成安全、显式 `isError=true` 的 tool result，让模型可以修正或基于已有证据继续。原始异常消息不发回模型，防止密钥或供应商细节泄漏。只有显式 `code=cancelled`，或外部 signal 已 aborted 且 handler 抛出 `AbortError`，才继续进入取消生命周期；工具内部用 `AbortError` 表达 timeout 不会自动误判取消。模型 adapter 错误继续抛出，由未来 graph policy 决定重试或终止。
6. 只有 trim 后非空的 `end_turn` 文本是 `completed`，返回时仍保留原始文本。空白最终文本、非法响应、`max_tokens`、`refusal`、`pause_turn` 和轮次耗尽返回结构化 `inconclusive`，并尽量保留当轮 partial text；不得再把空字符串当作成功正文。
7. Writer 的 search handler 消费结构化 `ResearchResult`。给模型的结果只包含提炼摘要与有序 citation，执行记录另外保留 provider/request id 与来源 title/URL/date/score；原始 source content 不进入 tool result。`unavailable` / `failed` 明确标错并提醒模型不能当作证据。
8. Tool loop 结果保存 metadata-only 的 model call 记录（provider/model/stop reason/usage/request id）。started/finished observer 不携带工具正文或任意 metadata，且是不会中断写作的 best-effort 观测入口；durable business event 必须由未来 graph/Worker 以幂等、事务语义另行写入。完整 transcript 与 execution content 只供本次编排使用，可能包含用户输入、模型输出和工具参数；只有在显式采样、去标识化、访问控制和保留策略下才能持久化。
9. `WriterService.write()` 的语义是“完成一章后返回一次”，与旧 `write_stream()` 实际只 yield 完整章节一致。本迭代不宣称 token streaming。
10. 本迭代只建立 port、领域实现、fixture 和 component eval；没有真实 ToolModel/provider adapter、LangGraph.js 组图、Worker 接线或生产切流。Python 仍是可运行后端。

## 结果

- Writer、Research 和工具协议可以用 scripted model 确定重放，为后续 memory/eval 工具复用相同注册、预算和观测边界；
- Provider adapter 可以替换而不改变 Agent core，但这种可替换性在真实 adapter 集成测试前只是接口属性；
- 搜索预算成为可 checkpoint 的 `ToolBudgetUsage`，工具失败和不完整正文进入可查询的结构化状态；
- 允许最终化请求可能比 Python 多一次模型调用，需要在真实模型 shadow eval 中继续衡量成本和正文完成率。

## 未选择

- 在 Agent core 直接使用 Anthropic SDK block：迁移最快，但会把供应商协议扩散到 graph、memory 和 eval。
- 复制 Python 的空字符串 fallback：表面兼容，却无法区分失败、不完整和合法空内容。
- handler 抛错立即终止整章：对不可恢复错误更快，但会丢失模型基于已有资料降级完成的机会。
- 本轮直接接 LangGraph.js 或真实模型：在工具协议和确定性失败语义尚未固定时，集成问题会掩盖领域回归。
