# Iteration 0075：写作入口发送稳定 Job Idempotency-Key

> 状态：Done  
> 日期：2026-08-30

## 目标

让浏览器创建 Job 时携带稳定 `Idempotency-Key`，避免同一次提交在响应丢失后被服务端当成新任务。

## 范围内

- `createJob` 浏览器 client 发送 `Idempotency-Key`；
- 同一规范化 payload 在成功前复用 `job-ui-{uuid}`，成功或换主题后换新键；
- 工作台 `handleSubmit` 改为走共享 client；
- 浏览器 HTTP client 收到 `src/lib/api`，不与 `app/api` Route Handler 并列。

## 范围外

- 不改 Route Handler 对缺失 header 的 `randomUUID()` 回退；
- 不改 reply/cancel 或 Job 恢复（恢复仍用 `job_id`）。

## 验证

- `pnpm --filter @vibe-writer/web exec vitest run src/lib/api/jobs.test.ts src/lib/storage/jobIdempotency.test.ts src/components/writing/WritingWorkspace.test.tsx src/components/articles/ArticlePage.test.tsx`：通过，4 files / 6 tests。
