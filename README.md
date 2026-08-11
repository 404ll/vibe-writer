# Vibe Writer

Vibe Writer 是一个全 TypeScript 的 AI 长文写作 MVP。用户提交主题后，系统生成并确认大纲，完成资料搜索、逐章写作和审稿，最后把文章及其历史版本持久化到 PostgreSQL。

Python/FastAPI 兼容运行时已经退役。当前只有一条产品链路：

```text
Next.js Web/API
  → PostgreSQL Job + Outbox
  → BullMQ / Redis
  → TypeScript Worker + LangGraph.js
  → PostgreSQL Event / Checkpoint / Article
  → Next.js SSE / Article UI
```

## 运行边界

- `apps/web`：Next.js App Router，负责页面、Route Handler、SSE 和文章读写；可部署到 Vercel。
- `apps/worker`：常驻 Node.js 进程，负责 BullMQ、LangGraph.js、模型和搜索调用；部署在长期运行的服务器或容器平台。
- `packages/db`：PostgreSQL/Drizzle schema、migration、RLS 和 durable repository。
- `packages/contracts`：Web、Worker 与 Eval 共享的 Zod 契约。
- `packages/agent-core`、`packages/workflow-runtime`：不依赖 HTTP、数据库或供应商 SDK 的 Agent 领域逻辑。
- `apps/eval`、`packages/eval-*`：版本化回归 Eval。Memory 实验代码已归档，默认不进入产品运行路径。

Vercel 只承载 Web/API。BullMQ Worker 需要持续监听 Redis，不能作为常驻进程放进 Vercel Function。Web、Worker 必须能访问同一套 PostgreSQL 和 Redis；PostgreSQL 是事实来源，Redis 只负责分发、重试和并发控制。

## 本地 MVP

前置条件：Node.js 22+、pnpm 10、Docker，以及可用的 Anthropic key。Tavily key仅在需要联网搜索时使用。

```bash
cp .env.example .env
pnpm install
pnpm dev:durable
```

`pnpm dev:durable` 会启动本地 PostgreSQL、Redis、Next.js 与 TypeScript Worker，并使用只允许 development 的固定单用户身份。打开 <http://127.0.0.1:3000>。

停止应用后，本地数据库 volume 默认保留：

```bash
pnpm dev:durable:down
```

## Vercel Preview

推荐先部署受保护的 Preview，而不是直接开放 Production：

1. Vercel Project 的 Root Directory 选择 `apps/web`，保持 Include source files outside Root Directory 开启。
2. 开启 Vercel Authentication，保护 Preview Deployment。
3. 按 [`apps/web/.env.example`](./apps/web/.env.example) 配置 Preview 环境变量。
4. 使用可从 Vercel 与 Worker 主机访问的 PostgreSQL，并把 `DATABASE_API_URL` 设置为专用非 owner API role。
5. 在独立服务器启动 Worker；Worker 使用自己的 dispatcher/consumer 数据库角色、Redis 和模型凭据。

完整顺序见 [`docs/refactor/runbooks/vercel-preview.md`](./docs/refactor/runbooks/vercel-preview.md)。当前 `protected-single-user` 身份模式只允许在 Vercel Preview 中使用；它要求部署保护已开启，不能作为公开生产认证。

## 常用命令

```bash
pnpm dev:durable
pnpm test:durable-product:local
pnpm test:worker:production:local
pnpm test:web
pnpm build:web
pnpm verify
```

`pnpm verify` 执行 TypeScript contracts、Agent、workflow、DB、Worker、Eval、Web、lint、build 和文档检查。需要真实 PostgreSQL/Redis/Docker 的重型 composition 使用单独命令运行。

## 关键环境变量

Vercel Web/API：

- `NEXT_PUBLIC_API_BASE=/api/durable`
- `DURABLE_API_ENABLED=true`
- `DATABASE_API_URL`
- `DURABLE_AUTH_MODE=protected-single-user`
- `DURABLE_EXTERNAL_ACCESS_PROTECTION=true`
- `DURABLE_SINGLE_USER_PRINCIPAL_ID`
- `DURABLE_SINGLE_USER_WORKSPACE_ID`

常驻 Worker：

- `DURABLE_WORKER_ENABLED=true`
- `DATABASE_WRITE_DISPATCHER_URL` / `WRITE_DISPATCHER_DATABASE_ROLE`
- `DATABASE_WRITE_CONSUMER_URL` / `WRITE_CONSUMER_DATABASE_ROLE`
- `REDIS_URL`
- `ANTHROPIC_API_KEY`
- `TAVILY_API_KEY`（可选）

更多设计、ADR、迭代和验证证据统一在 [`docs/refactor`](./docs/refactor/README.md)。
