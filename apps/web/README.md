# Vibe Writer Web

`apps/web` 是产品唯一的 Next.js App Router Web/API。浏览器 API 默认使用同源 `/api/durable`；文章 Server Component 直接通过共享 PostgreSQL repository 读取，不存在 FastAPI rewrite 或 SQLite fallback。

## 路由

- `/`：写作工作台，任务状态通过可重连 SSE 投影。
- `/articles/[id]`：文章阅读、编辑和历史版本。
- `/api/durable/**`：Job、SSE、Article 与 health Route Handler。

`/memory` 及对应 API 是归档且默认关闭的实验模块，不属于当前产品 MVP。

## 本地运行

从仓库根目录运行：

```bash
pnpm dev:durable
```

它会组合本地 PostgreSQL、Redis、Next.js 与 TypeScript Worker，并设置只在 development 生效的固定 principal/workspace。单独执行 `pnpm dev:web` 时需要自行提供数据库、身份和 Worker。

## Vercel Preview

Vercel Project Root Directory 设为 `apps/web`，并保持 workspace 外部文件包含开启。`vercel.json` 会从 monorepo 根目录安装依赖并构建 `@vibe-writer/web`。

Preview 必须开启 Vercel Authentication，并使用 [`apps/web/.env.example`](./.env.example) 中的 `protected-single-user` 配置。该身份模式会在非 Vercel Preview、未声明外部保护或 UUID 非法时 fail closed，不能用于公开 Production。

Web/API 与外部常驻 Worker 必须连接同一 PostgreSQL；Worker 还需要 Redis/BullMQ。完整部署清单见 [`docs/refactor/runbooks/vercel-preview.md`](../../docs/refactor/runbooks/vercel-preview.md)。

## 验证

```bash
pnpm test:web
pnpm build:web
pnpm lint:web
```
