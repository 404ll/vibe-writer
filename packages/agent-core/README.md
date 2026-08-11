# @vibe-writer/agent-core

与 HTTP、队列、数据库、LangGraph 和 provider SDK 无关的写作领域组件。

Iteration 0005 首先迁移 Planner 与 Reviewer；Iteration 0006 增加 CoveragePlanner、Research 与供应商无关的 SearchProvider port；Iteration 0007 增加 Writer、严格工具 schema、有界 ToolLoopRunner 和可跨重写 checkpoint 的 `ToolBudgetUsage`。它们只依赖共享 contract 和 `@vibe-writer/model-runtime` 的模型 port，因此测试和 eval 可以注入 scripted model/search provider。完整 LangGraph.js、真实 provider adapter 和运行时切流仍在后续迭代。
