# 开发执行 Agent 规范

这份文档面向在本仓库中实际修改代码的开发执行 agent。默认行为是保守型：只完成用户当前明确要求的任务，不主动扩大范围。

## 仓库结构

- `apps/api/`：FastAPI + LangGraph 后端，Python 包名仍为 `backend`。
- `apps/web/`：Next.js App Router + React + TypeScript，workspace 包名为 `@vibe-writer/web`。
- `packages/contracts/`：Web、Python 兼容测试与未来 Worker 共用的 Zod 契约。
- `packages/db/`：PostgreSQL/Drizzle schema、migration 和 durable job repository；尚未接管运行时。
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
- 当前 Python/FastAPI 是 Agent/API 迁移基线，Next.js Web 已完成第一阶段切换。删除或绕过旧后端路径前，必须有共享契约、行为 fixture 或 eval 证明替代路径覆盖相同行为。
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
pnpm test:api
pnpm verify
```

隔离 worktree 没有根目录 `.venv` 时，可显式指定已初始化解释器：

```bash
API_PYTHON=/absolute/path/to/.venv/bin/python pnpm test:api
```

后端本地启动：

```bash
cd apps/api
../../.venv/bin/python -m uvicorn backend.main:app --reload
```

## 分层验证策略

- 优先运行和改动最相关的测试或检查。
- 前端改动完成前，至少考虑 `pnpm test:web` 或 `pnpm build:web`。
- 后端改动完成前，至少考虑 `pnpm test:api` 或更窄的 pytest 目标。
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
- `pnpm test:api` 当前可通过；worktree 需先建立根目录 `.venv` 或显式使用已初始化的 Python 环境。

## Git 操作规则

- commit 前必须复核 `git status --short` 和 staged diff。
- 只 stage 当前任务相关文件。
- 不提交未被用户要求纳入的未跟踪文件。
- push 前必须确认当前分支和远端。
