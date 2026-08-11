# ADR-0009：纯 Agent Core 与 LangGraph Workflow Runtime 分层

- 状态：Accepted
- 日期：2026-08-07

## 背景

R4 已把 Planner、Coverage/Research、Writer/tool loop 和 Reviewer 迁为不依赖 HTTP、数据库、队列与供应商 SDK 的 TypeScript 领域组件。下一步需要组装可恢复状态图，但现有 ADR-0006 明确禁止 `packages/agent-core` 导入 LangGraph 类型；直接放开该边界会让 checkpoint、interrupt、Command 和框架升级进入所有 component test 与未来 memory/eval 组件。

Python graph 也不是可照搬的 durable 基线：大纲确认在 `plan_node` 内等待进程内 `asyncio.Event`，没有使用 LangGraph interrupt；SSE 和文件/SQLite 副作用位于节点内部；章节并行写作的 checkpoint 粒度是整个 write node；搜索预算在每次轻审重写时重置；全文第二轮失败后静默接受。

LangGraph 官方文档说明：interrupt 需要 checkpointer 和 thread id；resume 会从节点开头重新执行；interrupt 前的副作用必须幂等，调用顺序不能漂移，payload 必须可序列化。checkpoint replay 还会重新执行 checkpoint 之后的 LLM、工具与 interrupt。参考 [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)、[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) 与 [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)。

## 决定

1. `packages/agent-core` 继续只承载领域服务、纯 policy 和 JSON 数据类型，不导入 LangGraph。新增 `packages/workflow-runtime` 负责 LangGraph.js StateGraph、interrupt/Command、checkpointer 接口和节点组装；未来 `apps/worker` 注入 provider、数据库、事件与队列 adapter。
2. graph 的应用 channel state 只保存 Zod 校验的 JSON payload：输入、outline、章节内容/审稿状态、有限 attempt 计数、`ToolBudgetUsage`、execution config、版本和结构化 failure。client、AbortController、Error、SDK message、callback、数据库连接与完整 model/tool transcript 不进入应用 state。LangGraph checkpoint envelope 还包含 metadata、pending write、task/interrupt 等框架数据；其 serializer、兼容性和容量必须在 PostgresSaver 集成测试单独验证，不能由应用 state round-trip 代替。
3. 大纲生成、人工确认和大纲修改拆成 `plan → outline_review → revise_outline`。`outline_review` 每次执行只调用一个固定位置的 `interrupt()`；resume payload 使用显式 `confirm | revise` action，legacy HTTP reply 只能在 adapter 边界归一化，空消息且无 outline 不能隐式确认。确认后进入章节初始化，文字反馈进入独立 revise 节点再回 review。这样 resume 不会重复 plan/revise 模型调用。直接编辑 outline 与文字反馈同时出现时，以编辑稿作为 revise 输入。
4. Iteration 0008 先用逐章 checkpoint 的确定性控制流，不在一个 write node 内 `Promise.all` 全部章节。这样单章失败/replay 不会重做已完成章节，事件顺序和预算也可重放。跨章节并行保留为有独立 chapter subgraph/checkpoint 和并发 eval 后的优化，不复制 Python 的粗粒度并行。
5. `ToolBudgetUsage` 随章节 state 持久化，轻审重写、全文重写和 graph retry 都必须传回 Writer；搜索 3 次和总 dispatch 8 次是整章预算。这个保证只覆盖“调用已返回并成功 checkpoint”的 attempt；进程在付费调用完成后、checkpoint 前崩溃仍是 at-least-once，R5 必须增加 tool-call journal/idempotency key，或接受并监控 crash window 内可能重复调用的语义。
6. Planner/Coverage/Writer/Reviewer 的 `inconclusive`、非法返回和非取消类 service exception 都不能当作通过。节点把它们计入同一有限领域 attempt；用尽后写入结构化 terminal failure。具体 reason 到 retry/terminal 的表由 workflow policy 固定并用纯测试覆盖，Worker 基础设施重试不能绕过领域 attempt 上限。显式 `AbortError` 保持向上传播，由 Worker 的取消状态机收敛。
7. 轻审失败最多重写一次，并对重写稿再审一次；第二次明确 failed 可带 warning 进入全文审稿，inconclusive 则终止。全文最多两轮；第二轮仍 failed 时保留 quality warning 后进入 export，兼容当前产品“有限重写后交付”但不再静默。未来质量 eval 可以决定是否改为 terminal failure。
8. graph 的 export 节点只生成确定性 Markdown 与 export intent/idempotency key。文件、article/version、job terminal event 等副作用由 Worker/DB transaction 执行；R4 不把本地文件或 SQLite 写入 LangGraph 节点。
9. node update/interrupt 是 workflow 信号，不直接等于 SSE。R5 projection 层根据 durable DB transition 产生 sequenced job event，避免 checkpoint replay 重复向客户端推送副作用。
10. Iteration 0008 使用 in-memory checkpointer 和 scripted services 验证 graph；PostgresSaver、Worker resume、取消、lease 和真实 adapter 属于 R5 集成验证，不能由 component graph test 代替。
11. 每次 run 的应用 state 固定 `executionConfig`：graph、prompt set、model profile、toolset 和 code revision。Iteration 0008 的默认值明确为 `prototype-unbound`；生产 Worker 不得使用该默认值，必须保存真实 config id，并按 graph version 选择兼容 runtime 或显式迁移器。
12. PostgresSaver 上线前必须定义 checkpoint namespace/授权、加密、TTL/删除级联、单字段/总 payload 上限和完成后压缩策略。当前 state 会包含正文与人工/审稿反馈，不得把 MemorySaver 原型视为隐私和保留策略已完成。
13. workflow-runtime 不直接写 trace/DB，但 Worker 必须消费一个 bounded run-record projection：node、attempt、operation、model/tool version、usage、latency、request/trace id 和 replay identity。正文、完整 transcript 与 tool output 仍按采样、去标识化和保留策略决定是否记录。

## 结果

- 领域组件、memory/eval policy 不被 LangGraph API 绑住，workflow adapter 仍能使用官方 interrupt/checkpoint；
- checkpoint 粒度从“整批章节”收窄到单章，牺牲当前任务内章节并行以换取明确 replay 语义；
- 人工确认从进程内阻塞迁为可恢复协议，但只有接入 durable checkpointer 和 API resume 后才具备生产可靠性；
- Python 的静默接受、预算重置和节点副作用成为显式 migration delta。
- `executionConfig` 为后续 memory/eval 提供运行重建锚点，但真实版本绑定、旧 graph registry/migration 和 run-record projection 仍待 R5 完成。

## 未选择

- 直接在 `agent-core` 导入 LangGraph：文件更少，但破坏既有框架隔离和 component eval 边界。
- 在 plan node 中调用模型、发事件再 interrupt：resume 会重跑 interrupt 前逻辑，容易重复调用与事件。
- 立即并行所有章节：延迟更低，但 checkpoint/replay、预算与有序事件尚无可证伪设计。
- R4 直接接 PostgresSaver 与生产 DB：会把 graph policy 问题和 Worker/基础设施问题混在同一迭代。
