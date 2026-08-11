# ADR-0006：Agent Core 使用自有模型端口并显式处理无效输出

- 状态：Accepted
- 日期：2026-08-07

## 背景

当前 Python `BaseAgent` 直接创建 Anthropic client，Planner、Reviewer、Writer 等组件继承后调用。模型 SDK 的 content block、stop reason 和异常形态因此进入业务实现，也让单元测试依赖不完整的 `MagicMock`。后续需要同时支持供应商切换、trace、usage、离线 eval、memory context 和取消信号，继续让核心组件认识 SDK 类型会扩大耦合。

另一个现状是 Reviewer 在 JSON 无法解析或全文结果缺失时默认 `passed=true`。这有利于旧流程不中断，却违反 ADR-0004“grader 失败不能自动等同业务通过”的原则，也会让质量退化在 eval 中消失。

## 决定

1. `packages/model-runtime` 定义项目自有 `TextModel` port。请求至少包含 operation、prompt version、system/user prompt、max tokens 和可选 abort signal；响应统一包含 text、provider、model、finish reason、usage 与 request id。
2. `packages/agent-core` 只依赖 `TextModel` 和领域数据，不导入 Anthropic、LangChain、LangGraph、Next.js、数据库、队列或 trace vendor 类型。
3. provider adapter 负责把具体 SDK 响应转换为 port response，并把鉴权、限流、超时、取消、空响应和供应商错误转换成结构化 `ModelRuntimeError`。
4. Prompt 使用显式版本常量。每次调用把 component operation 与 prompt version 传给模型端口，未来写入 run/trace/eval trial。
5. Reviewer 使用三态 verdict：`passed | failed | inconclusive`。确定性字数门槛可以直接返回 failed；模型输出无法解析、schema 不合法或结果数量不足时返回 inconclusive，不得静默通过。
6. Python 旧行为作为 compatibility baseline 保留在共享 fixture；TS 的安全语义作为 target expectation 单独记录。已知差异必须进入迁移报告，不能为了逐字段相等而复制缺陷。
7. `TextModel` request 在进程内需要完整 system/user prompt 才能调用 provider，但默认持久化只记录 operation、prompt version/hash、provider/model、usage、latency、error 和 trace id。原始 prompt/response 只有在明确启用、完成敏感信息脱敏并设置保留期后才能进入 trace/eval 数据。

## 为什么暂不把 LangChain 类型作为端口

LangGraph.js 是低层编排 runtime，本身不要求必须使用 LangChain model abstraction。自有窄端口只覆盖项目真正需要的 text/structured generation、usage、version 和取消语义，可以减少核心包对框架版本与供应商消息形态的依赖。具体 adapter 仍可使用 `@langchain/anthropic`、其他 LangChain integration 或供应商 SDK。

## 结果

- Planner/Reviewer 可以用 scripted model 做无网络确定性测试；
- eval harness 能按 operation、prompt version、provider/model 归因；
- memory retrieval 未来以构造 prompt/context 的 adapter 输入加入，而不是侵入供应商 SDK；
- graph node 只组合领域服务和 state，checkpoint 不序列化 client、error 或 SDK message class；
- 旧 Python fail-open review 与 TS target 语义不完全相同，切流前必须更新 graph 对 inconclusive 的重试/失败策略。

## 未选择

- 核心包直接依赖 Anthropic SDK：与现有实现相同，供应商和测试耦合无法消失。
- 核心包直接暴露 LangChain `BaseChatModel`：减少一层 adapter，但把整个框架对象模型变成长期领域契约。
- 无效 Reviewer 输出继续默认通过：迁移更容易，但会把 grader 故障伪装成质量通过。
- 本迭代直接组装完整 LangGraph.js：没有先验证组件行为，无法定位迁移差异。
