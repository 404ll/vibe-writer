# 开发执行 Agent 规范

这份文档面向在本仓库中实际修改代码的开发执行 agent。默认行为是保守型：只完成用户当前明确要求的任务，不主动扩大范围。

## 仓库结构

- `apps/api/`：FastAPI + LangGraph 后端，Python 包名仍为 `backend`。
- `apps/web/`：React + TypeScript + Vite 前端，workspace 包名为 `@vibe-writer/web`。
- `docs/`：架构、评估、开发说明和任务 SPEC。
- `output/`、`data/`、`node_modules/`、`apps/web/dist/`：生成物或本地状态，不应提交。

## 工作原则

- 开始前先运行 `git status --short`，确认是否有用户未提交改动。
- 只修改任务明确涉及的文件；发现无关问题时记录并报告，不顺手修。
- 不覆盖用户已有改动。若任务必须触碰同一文件，先读 diff 并在现有改动上继续。
- 不修改 `.env`，不提交密钥、数据库、构建产物或本地缓存。
- 不做无关重构、视觉重设计、依赖升级或格式化全仓库。
- 默认不 commit、不 push、不创建 PR；只有用户明确要求时才执行对应 git 操作。

## 常用命令

从仓库根目录运行：

```bash
pnpm dev:web
pnpm build:web
pnpm test:web
pnpm lint:web
pnpm test:api
pnpm verify
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
- `pnpm lint:web` 当前存在既有 lint 错误。
- `pnpm test:api` 当前存在既有 Agent mock 相关失败。

## Git 操作规则

- commit 前必须复核 `git status --short` 和 staged diff。
- 只 stage 当前任务相关文件。
- 不提交未被用户要求纳入的未跟踪文件。
- push 前必须确认当前分支和远端。

