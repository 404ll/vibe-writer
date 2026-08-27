# Iteration 0072：Workflow Runtime 模块职责拆分

- 状态：Done
- 日期：2026-08-26
- 关联：无新 ADR；本轮不改变运行时、数据所有权或技术选择

## 目标

把 `packages/workflow-runtime/src/graph.ts` 中的编译期类型、运行时校验和 Graph 执行逻辑拆到职责单一的模块，降低阅读成本，同时保持现有包根导入方式和运行行为不变。

## 本轮范围

- 新增 `types.ts`，承载 `WorkflowNodeName`、`WorkflowServices` 与节点职责说明；
- 新增 `schemas.ts`，承载会在运行时执行的 Zod Schema 与 `WorkflowGraphState`；
- 收窄 `graph.ts`，只保留辅助函数、节点实现、条件边、Graph 编译和恢复入口；
- 保持包根对 `WorkflowGraphState`、`WorkflowServices` 的既有导出；
- 增加架构测试，防止编译期类型重新混入 Graph 运行文件。

## 范围外

- 不改变节点、条件边、重试预算、中断与恢复语义；
- 不拆分单个 Node 到更多文件；
- 不改变 Worker、Checkpoint、数据库或前端调用；
- 不新增依赖。

## 验证证据

- `pnpm --filter @vibe-writer/workflow-runtime test`：2个文件、51项测试通过；
- `pnpm --filter @vibe-writer/workflow-runtime typecheck`：通过；
- `pnpm --filter @vibe-writer/worker test`：14个文件、92项测试通过；
- `pnpm --filter @vibe-writer/worker typecheck`：通过；
- `pnpm --filter @vibe-writer/checkpoint-runtime test`：2个文件、10项测试通过；
- `pnpm --filter @vibe-writer/checkpoint-runtime typecheck`：通过；
- `pnpm check:docs`：213个Markdown文件链接检查通过；
- `git diff --check`：通过。

## 退出条件

- Workflow Runtime 测试与类型检查通过；
- Worker 测试与类型检查通过，证明包根公共导出兼容；
- 文档检查与 `git diff --check` 通过；
- diff 中没有流程行为变化。

以上退出条件已经满足。
