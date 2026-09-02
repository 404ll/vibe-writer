# Iteration 0079：规划阶段实时日志展示

> 状态：Done
> 日期：2026-09-02

## 目标

让已有的 durable 规划事件在「实时日志」中可见，避免任务已经进入规划或等待大纲确认时，日志仍显示“等待任务开始”。

## 范围内

- 将 `stage_update(plan)` 映射为规划中的活动日志；
- 将 `outline_ready` 映射为大纲已生成、等待确认的活动日志；
- 增加组件回归测试，证明 SSE 回调驱动日志更新。

## 范围外

- 不新增或伪造模型思考、token 级流式事件；
- 不修改 SSE、Worker、数据库或事件契约；
- 不处理 Planner 写作风格传递。

## 验证

- `pnpm --filter @vibe-writer/web exec vitest run src/components/writing/WritingWorkspace.test.tsx`：通过，1 file / 2 tests；
- `pnpm --filter @vibe-writer/web exec tsc --noEmit`：通过；
- `pnpm test:web`：通过，24 files / 79 tests；
- `pnpm lint:web`：通过；
- 本地真实任务 `05a60017-1036-4d44-bee8-79ccb7fdfee0` 的历史事件重放验证通过：页面日志依次显示规划中与等待大纲确认；
- `pnpm check:docs`、`git diff --check`：通过。

## 剩余风险

- 规划模型调用期间目前只有阶段开始和大纲完成两个真实事件，不代表 token 级实时输出。
