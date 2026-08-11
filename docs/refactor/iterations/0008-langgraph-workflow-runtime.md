# Iteration 0008：LangGraph Workflow Runtime

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R4 TS Agent core
- 对应决策：[ADR-0004](../decisions/0004-evaluation-first-migration.md)、[ADR-0006](../decisions/0006-agent-core-model-port-and-invalid-output.md)、[ADR-0008](../decisions/0008-writer-tool-loop-and-tool-model-port.md)、[ADR-0009](../decisions/0009-pure-agent-core-and-langgraph-workflow-runtime.md)

## 目标

把已迁移的 TypeScript 领域组件组装为可 checkpoint、可 interrupt/resume、有限重试且失败显式的 LangGraph.js workflow，同时保持 `agent-core` 与框架解耦，并用 scripted services 固定 Python compatibility 与 TS target 的控制流差异。

## 范围内

- workflow Zod state、chapter state、failure、quality warning、graph version 和 execution config；
- `plan → outline_review/revise → chapter coverage/write/light-review → full-review → export` 控制流；
- 一个固定 interrupt 的大纲确认与多轮修改；
- `ToolBudgetUsage` 跨轻审/全文重写/checkpoint；
- component inconclusive 的有限 retry/terminal policy；
- 逐章 checkpoint、确定性 Markdown/export intent；
- in-memory checkpointer scripted graph tests、共享 fixture、ADR/Eval/迭代记录。

## 范围外

- 不实现真实 provider/Search adapter，不发模型或搜索网络请求；
- 不实现 PostgresSaver、BullMQ Worker、lease/heartbeat/reconciler、生产取消或 SSE projection；
- 不写本地文件、SQLite/PostgreSQL article 或 terminal job event；
- 不切换 FastAPI/Python 运行时；
- 不宣称进程重启恢复、重复投递幂等或生产吞吐已经验证；
- 不实现 memory candidate/retrieval 或 eval queue。

## 必须证明的行为

1. Agent core 继续不导入 LangGraph，workflow-runtime 不导入 Next.js、DB、BullMQ 或 provider SDK；
2. 应用 channel state 只包含 schema 可验证的 JSON 数据；真实 checkpoint envelope 留给 PostgresSaver 集成验证；
3. outline interrupt 可 resume，修改后再次确认且不会重复 plan/revise；
4. 已完成章节在 replay/rewrite 中不被无条件重做；
5. tool budget 跨所有同章 write attempt 累积；
6. Planner/Coverage/Writer/Reviewer inconclusive 有有限、可测试的 policy；
7. 轻审与全文重写次数有硬上限，第二轮全文 failed 产生 warning 而非静默通过；
8. export 只产出 Markdown 与幂等 intent，不执行基础设施副作用；
9. Python/TS 共享 fixture 机器验证 rewrite route 与 intentional delta；interrupt、replay 和 side-effect ownership 由 TS graph test 与架构边界测试验证，不伪装成 Python/TS component 等价结论；
10. graph version、dataset version、测试命令和未验证边界进入 Eval 0004。

## 当前状态

已实现：

- `packages/workflow-runtime/src/state.ts`：JSON/Zod workflow/chapter/failure/export state；
- `packages/workflow-runtime/src/policy.ts`：Writer/component retry 与 full-review route policy；
- `packages/workflow-runtime/src/graph.ts`：LangGraph StateGraph、interrupt/resume 和逐章节点；
- `workflow-control-baseline-v1`：Python/TS rewrite route 与 TS Writer policy fixture；
- MemorySaver scripted graph、架构边界与 Python compatibility tests；
- 从第一章完成 checkpoint replay：同一 saver 重建 graph 后，第一章 coverage/write/light-review 不重复，第二章重新执行；
- terminal checkpoint replay 不重复任何 component 调用；
- Coverage `ready + []`、额外全文审稿结果、非取消类 service exception 均在两次领域 attempt 内显式失败；
- outline 使用显式 action，legacy `outline: null` 在 adapter 边界归一化，空对象不能隐式确认；
- 轻审与全文重写使用独立 counter，export idempotency key 跨 graph version 稳定；
- 六章路径由 runtime 内置 recursion limit 覆盖，不要求调用方调参。

最终验证：contracts 19、model-runtime 9、agent-core 92、workflow-runtime 47、DB 8、Python API 50、Web 12；全部相关 typecheck、migration check、Web lint、Next.js production build、31 份文档链接检查和 `git diff --check` 通过。架构、代码和 Eval 三类独立读者 closure 已完成；完整环境、artifact hash、dirty-worktree 与未验证边界见 [Eval 0004](../evals/0004-workflow-runtime-deterministic-baseline.md)。

## 本轮暴露并修复的问题

- 六章正常流程超过 LangGraph 默认 recursion limit：runtime 统一设置 100，并新增六章回归；
- Coverage 合法类型允许 `ready + []`，会无限路由并持续计费：runtime output schema 现在要求非空，非法返回计入有限 attempt；
- service exception 原本不会消耗 retry budget：非取消异常现在在各节点统一归入两次领域 attempt；
- MemorySaver 测试原本只证明同一 graph 对象 interrupt resume：现在重建 graph 并从章节 checkpoint/terminal checkpoint replay；
- `rewriteCount` 混合轻审/全文重写：拆成 `lightRewriteCount` 与 `fullRewriteCount`；
- export key 包含 graph version：改为稳定的 `job:{jobId}:article:export`，版本作为 execution metadata；
- state 只做初始 JSON round-trip：新增中间 checkpoint、completed 和 failed state schema/JSON 校验，以及 terminal/tool-budget 语义负例。

## 明确保留到 R5 的边界

- MemorySaver 只证明同进程 saver 的 checkpoint/replay；不证明进程重启或 PostgresSaver；
- 模型/工具调用完成但 checkpoint 前崩溃仍可能 at-least-once 重复计费，需要 journal/idempotency；
- 生产 Worker 必须写入真实 execution config，并按 graph version 选择 runtime/migrator；
- checkpoint 隐私、容量、TTL/删除级联与完成后压缩尚未实现；
- component metadata 尚未投影为 durable bounded run record，不能据此声称成本/来源审计已完成。

## 回滚

在接入 Worker 前，回滚只需移除 workflow-runtime package、fixture/test 和本迭代文档；现有 Python 运行路径与已完成 TS components 不受影响。
