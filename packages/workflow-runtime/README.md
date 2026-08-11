# @vibe-writer/workflow-runtime 工作流运行时

LangGraph.js 写作状态机决定节点按什么顺序执行、何时重试、何时暂停等待用户，以及什么状态才算完成。它不拥有网页接口、数据库、队列或供应商开发工具包。

## 状态图主流程

```text
规划
  → 大纲确认（可中断）
  → 初始化章节
  → 覆盖点规划 → 写作 → 章节轻审 → 下一章（逐章循环）
  → 全文审稿
  → 导出
```

代码中的节点名称分别是 `plan`、`outline_review`、`initialize_chapters`、`coverage`、`write`、`light_review`、`next_chapter`、`full_review` 和 `export`。用户要求修改大纲时，执行 `outline_review → revise_outline → outline_review`。组件返回不可用结果时由 `policy.ts` 决定重试还是进入显式失败状态，不让异常状态默默流到后续节点。

## 文件边界

| 文件 | 负责 |
|---|---|
| `src/state.ts` | 可序列化的工作流/章节状态、初始状态和 Markdown 导出意图 |
| `src/graph.ts` | LangGraph 节点、边、中断/恢复与服务调用顺序 |
| `src/policy.ts` | 重试次数、字数分配、审稿与失败的确定性决策 |
| `src/index.ts` | 对工作进程与测试暴露的稳定入口 |

`buildWorkflowGraph()` 只接收 `WorkflowServices` 接口，因此组件测试可以注入脚本化服务；生产工作进程则在组合入口注入真实智能体、供应商适配器和 PostgresSaver。

## 检查点与版本

- 状态是经过 Zod 校验的 JSON 消息体，必须可序列化；不要把开发工具包客户端、数据库连接或函数放进去。
- `executionConfig` 记录本次运行的状态图、提示词、模型、工具集和代码版本，重放不能偷偷切换“当前配置”。
- LangGraph 检查点封装由 `@vibe-writer/checkpoint-runtime` 持久化；本包只依赖 `BaseCheckpointSaver`。
- 检查点用于恢复一次任务，不是用户长期记忆。

```bash
pnpm --filter @vibe-writer/workflow-runtime test
pnpm --filter @vibe-writer/workflow-runtime typecheck
```
