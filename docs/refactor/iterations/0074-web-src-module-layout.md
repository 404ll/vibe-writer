# Iteration 0074：整理 `apps/web/src` 模块目录

> 状态：Done  
> 日期：2026-08-30

## 目标

把 `apps/web/src` 从根目录散文件和扁平 `components/` / `server/` 调整为可扩展的分层：共享 UI、按业务命名的组件，以及 `api` / `lib` / `types` / `server` 工具目录。

## 范围内

- 组件拆到 `components/ui`、`components/writing`、`components/articles`、`components/memory`；
- 根目录散文件迁到 `api/`、`lib/`、`types/`、`styles/`、`testing/`；
- 服务端模块按 `database`、`http`、`identity`、`jobs`、`articles`、`memory` 分组；
- 引入 `@/` 指向 `src/`，更新 Route Handler 与测试 mock；
- 同步 `apps/web/AGENTS.md` 与 README 路径。

## 范围外

- 不改页面行为、接口契约或运行时语义；
- 不弹出上一轮 Job `Idempotency-Key` stash；
- 不改 `packages/db`。

## 设计说明

对齐 Next.js 官方把 `app/` 留给路由、以及常见生产结构里的 `components/ui` + `lib` + 按功能拆组件。业务组件按写作 / 文章 / Memory 分目录；跨业务展示（Markdown）进入 `ui/`。`server/` 保持与 HTTP 边界同层，只按职责分子目录，避免把 Route Handler 逻辑垂直切进 feature 包。

## 验证

- `pnpm test:web`：通过，20 files / 69 tests；
- `pnpm lint:web`：通过；
- `pnpm build:web`：通过。
