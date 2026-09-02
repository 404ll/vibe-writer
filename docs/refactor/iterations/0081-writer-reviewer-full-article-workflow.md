# Iteration 0081：全文 Writer–Reviewer 协作工作流

> 状态：Done
> 日期：2026-09-03

## 目标

修复逐章生成导致的用户意图传递薄弱、风格只影响正文、章节拼贴感明显，以及全文审核返工后 Writer 失忆的问题；同时保留 durable checkpoint、HITL、fenced effect、SSE replay 和有界失败语义。

## 根因

- Planner 只接收 topic/篇幅，没有接收 style；“幽默风趣”等自定义要求不能影响大纲。
- 大纲反馈生成新标题后被清空，没有形成后续节点可消费的编辑决策。
- 每章 Writer/Reviewer 都是独立调用，Writer 看不到全文叙事，Chapter Reviewer 也没有相邻正文证据。
- Full Reviewer 发现全局问题后，只把孤立章节反馈交给新的章节调用，无法延续同一个全文 Writer 的正常上下文。

## 实现

- 新增 versioned `WritingBrief`、有界 `EditorialDecision`、provider-neutral `WriterSession`、带 compact 检索证据的 `SourceNotebook` 和严格 `ReviewReport`。
- `PlannerService` 从规划阶段消费完整 brief；自定义 style 被转成可执行指令，而不是裸标签。
- 新增 `WriterAgentService`：一次生成完整 Markdown，复用既有 search/diagram tool seam，并支持一次 `max_tokens` continuation。
- 新增隔离的 `ReviewerAgentService`：只看显式 artifacts 和完整 draft；空稿、结构、篇幅先走确定性检查。
- 新增 v2 LangGraph：`plan → outline_review → writer_agent → reviewer_agent → export | writer_agent`，Reviewer 最多完成两轮。
- checkpoint replay 在调用 provider 前校验 graph、prompt、model 与 toolset 语义版本；`codeRevision` 保留为审计字段，不阻断语义版本未变的普通部署。
- Worker 默认组合切换到 v2；SSE 沿用兼容事件 envelope，但内容改为真实的全文创作、审核和保存里程碑。
- production composition/cancellation/failure/takeover fixture 与 Eval baseline 分别提升到 v3/v2，真实投影从旧的 5 次组件调用更新为 Planner、Writer、Reviewer 3 次调用。
- 兼容策略记录在 [ADR-0072](../decisions/0072-full-article-writer-reviewer-workflow.md)：v1 paused checkpoint 不迁移，部署前排空或取消。

## 核心学习入口

| 文件 | 函数/类型 | 职责 |
|---|---|---|
| `packages/agent-core/src/writing-artifacts.ts` | `buildWritingBrief`、`appendEditorialDecision` | 把用户输入和大纲反馈变成有界、可 checkpoint 的编辑 artifacts |
| `packages/agent-core/src/writer-agent.ts` | `WriterAgentService`、`articleDraftBudget` | 运行对全文负责、可继续的 Writer tool loop |
| `packages/agent-core/src/reviewer-agent.ts` | `ReviewerAgentService`、`inspectDraftDeterministically` | 以新鲜上下文诊断完整草稿 |
| `packages/workflow-runtime/src/writer-reviewer-policy.ts` | `routeAfterReview` | 固定 approved、返工和轮次耗尽的确定性路由 |
| `packages/workflow-runtime/src/writer-reviewer-graph.ts` | `buildWriterReviewerWorkflowGraph` | 编排 durable HITL、Writer–Reviewer 循环和 export intent |

## 验证

- `pnpm test:contracts`：2 files / 31 tests；
- `pnpm typecheck:contracts`：通过；
- `pnpm --filter @vibe-writer/agent-core test`：5 files / 109 tests；
- `pnpm --filter @vibe-writer/agent-core typecheck`：通过；
- `pnpm --filter @vibe-writer/workflow-runtime test`：3 files / 66 tests；
- `pnpm --filter @vibe-writer/workflow-runtime typecheck`：通过；
- `pnpm --filter @vibe-writer/worker test`：14 files / 97 tests；
- `pnpm --filter @vibe-writer/worker typecheck`：通过；
- `pnpm test:web`：25 files / 87 tests；
- `pnpm --filter @vibe-writer/web exec tsc --noEmit`：通过；
- `pnpm --filter @vibe-writer/web lint`：通过；
- `pnpm test:worker:production:local`：5/5 production cases，并通过 `pnpm build:web`；
- `pnpm verify`：通过；
- `pnpm check:docs`：223 files 通过；
- `git diff --check`：通过。

## 范围外

- 不实现 Brave/SearXNG、网页正文提取或新的 SearchProvider；
- 不新增 Research Agent；
- 不恢复跨任务长期 Memory；
- 不持久化 chain-of-thought，也不展示伪造的 token 级思考；
- 不自动迁移 v1 paused checkpoint。

## 剩余风险

- 真实模型的一次全文输出质量、成本和 continuation 表现仍需 Preview 人工体验与 live Eval；loopback production gate 只证明协议和 durable 投影。
- `WriterSession` 会增加 checkpoint payload，虽有消息/字符上限，仍需用真实长文观察 PostgresSaver 体积。
- 为避免扩大既有 SSE 事件契约，本版用 `review_done.feedback` 的兼容标记表达“轮次耗尽”；后续可在独立契约版本中增加 typed `nextAction`。
- 与联网研究 PR 可能同时修改 Worker service composition、Agent 版本或 search seam；建议先合并本 PR，再让联网研究 PR 基于 v2 Writer Agent 解决冲突。
