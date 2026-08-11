# Iteration 0001：共享 TypeScript contracts 基建

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R1 契约与基线

## 目标

建立 Next.js、TS Worker、现有 Web 和未来测试共同依赖的契约 package，先消除前端私有 SSE/type 定义，不改变当前用户行为。

## 范围内

- workspace 纳入 `packages/*`；
- 新增 `@vibe-writer/contracts`；
- 使用 Zod 描述 job、article 和 SSE wire contract；
- 现有 Web 的 SSE inventory 和 article types 改从共享 package 获取；
- 增加 contracts test/typecheck 根命令；
- 建立系统设计、ADR、路线图和迭代记录。

## 范围外

- 不迁移 Next.js；
- 不实现 TS Worker；
- 不修改 FastAPI runtime 或 Python schema；
- 不切换 PostgreSQL/Redis；
- 不改变页面和 SSE 交互行为；
- 不处理现有 API test/lint 已知失败。

## 实施内容

- `packages/contracts/src/jobs.ts`：job request/response、stage、review schema；
- `packages/contracts/src/articles.ts`：article/version schema；
- `packages/contracts/src/sse.ts`：事件 inventory、终止集合和 discriminated union；
- `apps/web/src/sseEvents.ts`：保留迁移期兼容入口，转为 re-export；
- `apps/web/src/types.ts`、`api.ts`：复用共享推导类型。

## 验证

已执行：

```bash
pnpm test:contracts
pnpm typecheck:contracts
pnpm test:web
pnpm build:web
git diff --check
```

结果：

- `pnpm test:contracts`：通过，1 个测试文件、5 个测试。
- `pnpm typecheck:contracts`：通过。
- `pnpm test:web`：通过，1 个测试文件、4 个测试。
- `pnpm build:web`：通过；保留既有 Mermaid/Vite 大 chunk warning，不影响产物生成。
- Python producer 与 `packages/contracts/src/sse.ts` 的事件名集合对比：无差异。
- 重构文档相对链接检查：11 个 Markdown 文件全部可解析。
- `git diff --check`：通过。

文档读者问题检查覆盖了“当前和目标架构是什么”“Next 与 Worker 如何分工”“哪个系统是业务真相”“四类 memory 有何不同”“当前阶段和完成定义在哪里”。这些问题均能从文档中心和系统设计中得到单一、互不矛盾的答案。

额外运行 `pnpm lint:web`，结果仍为 6 个既有错误，位于本轮未修改的 `HistoryPanel.tsx`、`markdownComponents.tsx` 和 `useJobStream.ts`。本迭代不以修复全仓 lint 为目标，因此不扩大范围。

## 退出条件

- contracts 测试和 typecheck 通过；
- Web 测试和 build 通过；
- SSE inventory 仍与当前 Python producer 事件集合一致；
- 文档记录真实验证结果和剩余风险。

## 下一步

Iteration 0002 将把当前 FastAPI API/SSE 样本固化为 fixture，并让 Zod 在测试中直接解析 Python producer 输出；同时建立 prompt/model/tool version manifest。

## 遗留风险

- Python/Pydantic 还不能直接导入 TypeScript schema；迁移期的契约一致性目前由测试和 fixture 保证。
- Web 目前只复用共享类型和 SSE inventory，尚未对所有 HTTP 响应执行运行时 Zod parse。
- `JobEventSchema` 描述当前 wire payload；新增 producer 事件时必须同步修改 package 测试。
- `CreateJobRequestSchema` 已表达目标域约束（非空 topic、正整数 target words），而旧 FastAPI/Pydantic 对这两个字段更宽松；当前 Web 尚未使用该 schema 做运行时拦截，因此本迭代没有改变现有请求行为。切换 TS API 前必须用契约测试明确新的 4xx 行为。
- contracts 暂时直接导出 TypeScript source，适配当前 Vite/迁移环境；进入独立 Worker 构建前需要决定统一的 package build/output 约定。
