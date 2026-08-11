# 开发执行 Agent 规范

这份文档面向在本仓库中实际修改代码的开发执行 agent。默认行为是保守型：只完成用户当前明确要求的任务，不主动扩大范围。

## 仓库结构

- `apps/web/`：Next.js App Router + React + TypeScript，workspace 包名为 `@vibe-writer/web`。
- `apps/worker/`：BullMQ + LangGraph.js 常驻任务运行时。
- `packages/contracts/`：Web、Worker 与 Eval 共用的 Zod 契约。
- `packages/db/`：PostgreSQL/Drizzle schema、migration 和 durable repository。
- `packages/model-runtime/`：供应商无关的模型调用、usage 与错误端口。
- `packages/agent-core/`：与 HTTP、队列、数据库和 provider SDK 无关的 TS Agent 组件；尚未接管运行时。
- `docs/`：架构、评估、开发说明和任务 SPEC。
- `output/`、`data/`、`node_modules/`、`apps/web/.next/`、`apps/web/dist/`：生成物或本地状态，不应提交。

## 工作原则

- 开始前先运行 `git status --short`，确认是否有用户未提交改动。
- 只修改任务明确涉及的文件；发现无关问题时记录并报告，不顺手修。
- 不覆盖用户已有改动。若任务必须触碰同一文件，先读 diff 并在现有改动上继续。
- 不修改 `.env`，不提交密钥、数据库、构建产物或本地缓存。
- 不做无关重构、视觉重设计、依赖升级或格式化全仓库。
- 默认不 commit、不 push、不创建 PR；只有用户明确要求时才执行对应 git 操作。

## TypeScript 重构追踪规则

- 涉及 Next.js、TS Worker、contracts、PostgreSQL、memory 或 eval 的任务，开始前先读 `docs/refactor/README.md`、`system-design.md` 和 `roadmap.md`。
- 每次重构实施都要新增或更新 `docs/refactor/iterations/NNNN-*.md`，并同步 `iteration-log.md`；没有验证证据时不能标记 `Done`。
- 改变运行时边界、数据所有权、核心技术选择或兼容策略时，必须新增 ADR；不要直接改写已 Accepted ADR 的历史结论。
- Python/FastAPI 兼容运行时已退役。产品只允许 Next.js Route Handler + TypeScript Worker + PostgreSQL/BullMQ 主链路；历史 ADR/fixture 只作为迁移证据，不得重新接回运行时。
- Prompt、model profile、tool schema、graph 和 eval dataset 的变化必须可版本化，不能只依赖 Git diff 推断一次运行使用了什么配置。

## 常用命令

从仓库根目录运行：

```bash
pnpm dev:web
pnpm build:web
pnpm test:web
pnpm lint:web
pnpm test:contracts
pnpm typecheck:contracts
pnpm test:model-runtime
pnpm typecheck:model-runtime
pnpm test:agent-core
pnpm typecheck:agent-core
pnpm check:docs
pnpm test:db
pnpm typecheck:db
pnpm check:migrations
pnpm verify
```

## 分层验证策略

- 优先运行和改动最相关的测试或检查。
- 前端改动完成前，至少考虑 `pnpm test:web` 或 `pnpm build:web`。
- Worker 或 Agent 改动完成前，至少考虑对应 package test/typecheck；运行边界变化时运行 production composition。
- 全量 `pnpm verify` 只在用户要求、跨前后端改动较大、或准备发布时运行。
- 如果验证失败，要区分本次引入的问题和既有失败；不要为了让命令变绿而扩大任务范围。

## 已知验证状态

- `pnpm build:web` 当前可通过。
- `pnpm test:web` 当前可通过。
- `pnpm test:contracts`、`pnpm typecheck:contracts` 当前可通过。
- `pnpm test:model-runtime`、`pnpm typecheck:model-runtime` 当前可通过。
- `pnpm test:agent-core`、`pnpm typecheck:agent-core` 当前可通过。
- `pnpm test:db`、`pnpm typecheck:db`、`pnpm check:migrations` 当前可通过。
- `pnpm lint:web` 当前可通过。

## Git 操作规则

- commit 前必须复核 `git status --short` 和 staged diff。
- 只 stage 当前任务相关文件。
- 不提交未被用户要求纳入的未跟踪文件。
- push 前必须确认当前分支和远端。
