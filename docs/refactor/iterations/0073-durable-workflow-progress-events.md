# Iteration 0073：Durable Workflow 进度事件接线

> 状态：Done  
> 日期：2026-08-26

## 目标

把已有章节事件契约、PostgreSQL `job_events`、SSE read model 和前端消费逻辑接到当前 TypeScript Worker 生产组合，使实际工作流能够展示规划、逐章写作、搜索、审核和导出进度。

## 范围内

- Workflow Runtime 在稳定节点、章节、轮次和尝试边界产生非终态进度事件；
- Worker 使用当前 `jobId + runId + leaseToken` 调用 `appendRunEvent`；
- 事件幂等键只由稳定工作流坐标组成，Checkpoint replay 或 takeover 不重复插入；
- 真实 Writer search tool 调用产生 `searching` / `search_done`，不把 coverage 搜索建议冒充真实搜索；
- `chapter_done` 只在轻审最终结束后产生，首次失败并进入重写时不提前完成章节；
- 前端按章节标题去重完成数，避免全文重写或 SSE 重放导致计数超过大纲总数；
- PostgreSQL/PGlite 集成测试覆盖完整事件顺序及终态 `done`。

## 范围外

- 不实现 provider token streaming；当前 `writing_chapter` 在开始时发送空块切换 UI 状态，并在模型返回后发送一个完整章节块；
- 不改变终态事务：`done`、`cancelled`、`error` 仍由 terminal repository 原子提交；
- 不新增数据库 schema、migration 或 SSE 协议。

## 设计说明

`WorkflowProgressSink` 是 Workflow Runtime 的持久化无关端口。Graph 只决定何时产生什么业务事件；`DurableWorkflowExecutor` 把端口绑定到 `JobRepository.appendRunEvent`。若事件写入发现取消或租约丢失，执行器以 `AbortError` 停止 Graph，旧 Worker 不能继续调用供应商或写入进度。

事件写入和 LangGraph Checkpoint 仍是两个独立持久化动作，但稳定幂等键保证节点重放不会重复插入。终态事实继续由现有数据库事务负责，不被进度投影替代。

## 验证

- `pnpm test:workflow-runtime`：通过，2 files / 52 tests；
- `pnpm typecheck:workflow-runtime`：通过；
- `pnpm test:contracts`：通过；
- `pnpm typecheck:contracts`：通过；
- `pnpm test:worker`：通过，14 files / 95 tests；
- `pnpm typecheck:worker`：通过；
- `pnpm test:web`：通过，20 files / 69 tests；
- `pnpm lint:web`：通过；
- `pnpm build:web`：通过；
- `pnpm check:docs`：通过；
- `git diff --check`：通过。

## 剩余风险

- 完整章节块会作为 durable event data 保存，长文章会增加 `job_events` 存储量；未来若接 provider token stream，应采用有界批次而不是逐 token 写 PostgreSQL；
- 本迭代验证持久化顺序、重放幂等和前端消费，不宣称逐 token 实时输出。
