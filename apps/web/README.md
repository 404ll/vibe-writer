# Vibe Writer 网页端

`apps/web` 是产品唯一的 Next.js 应用，使用 App Router 承载网页与接口。它负责接收用户意图，并把数据库事实呈现为页面和接口响应；不在请求生命周期里执行长时间人工智能任务。

## 负责与不负责

- 负责页面、身份作用域、输入校验、任务/文章路由处理器、服务端推送和文章读写。
- 不负责 LangGraph、模型调用、BullMQ 消费或跨请求保存运行中状态。
- 浏览器默认使用同源 `/api/durable`；服务端组件和路由处理器都通过 `@vibe-writer/db` 数据仓储访问 PostgreSQL。
- 不存在 FastAPI 转发、SQLite 降级路径或“Vercel 函数内常驻工作进程”。

## 一次提交怎么走

1. `app/api/durable/jobs/route.ts` 校验身份和 `CreateJobRequestSchema`。
2. `src/server/durableDatabase.ts` 注入受工作区限制的数据仓储。
3. 数据仓储在同一事务写入 `jobs` 与 `outbox_events`，路由处理器立即返回 `job_id`。
4. 外部工作进程异步执行；网页端不等待模型完成。
5. `app/api/durable/jobs/[jobId]/stream/route.ts` 把 PostgreSQL 的 `job_events` 投影为服务端推送事件。
6. `src/hooks/useJobStream.ts` 用 `_seq` 去重、断线补播，并把终态交给页面。

这意味着页面刷新只会丢失一个可重建的视图，不会丢失任务本身。

当前服务端推送以短轮询读取 `job_events`，默认间隔为 500 毫秒，空闲时发送保活消息。它不依赖进程内事件发射器、Redis 发布订阅或 PostgreSQL 的 `LISTEN/NOTIFY`。这是最小可行产品中偏简单、但容易恢复和水平扩展的取舍。

## 路由

- `/`：写作工作台，任务状态通过可重连的服务端推送投影。
- `/articles/[id]`：文章阅读、编辑和历史版本。
- `/api/durable/jobs`：创建任务。
- `/api/durable/jobs/[jobId]/events` / `stream`：历史事件与实时服务端推送投影。
- `/api/durable/jobs/[jobId]/reply`：确认或修改大纲，并持久化恢复命令与事务发件箱记录。
- `/api/durable/jobs/[jobId]/cancel`：请求取消；工作进程心跳会观察并中止执行。
- `/api/durable/articles/**`：文章与版本读写；`/api/durable/health/**`：网页与接口健康检查。

`/memory` 及对应接口是归档且默认关闭的实验模块，不属于当前产品最小可行版本。

## 核心文件

| 文件 | 阅读重点 |
|---|---|
| `app/api/durable/jobs/route.ts` | 为什么接口只记账、不直接发布队列 |
| `src/server/durableDatabase.ts` | 身份、工作区作用域与专用接口数据库角色 |
| `app/api/durable/jobs/[jobId]/stream/route.ts` | 服务端推送游标如何进入数据库事件查询 |
| `src/server/durableSse.ts` | PostgreSQL 事件日志如何变成可重连的数据流 |
| `src/hooks/useJobStream.ts` | 历史补播、实时读取、`_seq` 去重和终态停止 |
| `app/articles/[id]/page.tsx` | 服务端组件如何直接读取文章事实 |

## 本地运行

从仓库根目录运行：

```bash
pnpm dev:durable
```

它会组合本地 PostgreSQL、Redis、Next.js 与 TypeScript 工作进程，并设置只在开发环境生效的固定主体与工作区。单独执行 `pnpm dev:web` 时需要自行提供数据库、身份和工作进程。

## Vercel 预览部署

Vercel 项目根目录设为 `apps/web`，并保持包含工作区外部文件开启。`vercel.json` 会从单体仓库根目录安装依赖并构建 `@vibe-writer/web`。

预览环境必须开启 Vercel 身份验证，并使用 [`apps/web/.env.example`](./.env.example) 中的 `protected-single-user` 配置。该身份模式会在非 Vercel 预览环境、未声明外部保护或通用唯一标识符非法时拒绝启动，不能用于公开生产环境。

网页接口与外部常驻工作进程必须连接同一 PostgreSQL；工作进程还需要 Redis 与 BullMQ。完整部署清单见 [`docs/refactor/runbooks/vercel-preview.md`](../../docs/refactor/runbooks/vercel-preview.md)。

## 验证

```bash
pnpm test:web
pnpm build:web
pnpm lint:web
```
