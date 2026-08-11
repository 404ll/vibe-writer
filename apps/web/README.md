# Vibe Writer Web

`apps/web` 是 Next.js App Router 应用。本地产品验证推荐由根目录 `pnpm dev:durable` 启动；该命令把浏览器和文章 Server Component 一起切到 `/api/durable`，并组合 PostgreSQL、BullMQ 与 TypeScript Worker。源码的普通 `pnpm dev:web` 默认值仍通过同源 `/api` rewrite请求FastAPI，用作兼容与回滚路径。

## 路由

- `/`：写作工作台，SSE 和交互状态位于 Client Component。
- `/articles/[id]`：文章阅读、编辑和历史版本。

`/memory`及对应API是归档的默认关闭实验模块，不属于当前产品MVP；`dev:durable`不会展示入口或启用其flag。

## 本地运行

推荐从仓库根目录运行完整 TypeScript durable 产品：

```bash
pnpm dev:durable
```

它会设置仅在development生效的`DURABLE_AUTH_MODE=local-development`和固定本地principal/workspace UUID；客户端伪造的identity header不会覆盖该身份，production环境也会fail closed。模型配置从根目录`.env`读取；隔离worktree可用`DURABLE_DEV_ENV_FILE=/absolute/path/to/.env`指定。

如需运行兼容FastAPI路径，先启动`apps/api`，再运行：

```bash
pnpm dev:web
```

默认把Next中不存在的`/api/*`作为fallback代理到`http://127.0.0.1:8000/*`。App Router Route Handler（包括动态`/api/durable/*`）优先匹配；不能把rewrite恢复成会抢占动态route的array form。可在`next build`时用`API_PROXY_TARGET`覆盖服务端代理目标；若浏览器需要直接请求外部API，可在构建期设置`NEXT_PUBLIC_API_BASE`。

`dev:durable`会把`NEXT_PUBLIC_API_BASE=/api/durable`、`DURABLE_API_ENABLED=true`和`DURABLE_ARTICLE_READ_ENABLED=true`作为同一运行单元，并自动配置经过verifier的本地非owner角色。公开部署仍必须替换本地身份为真实auth/Ingress，使用secret manager中的独立数据库凭据并处理历史数据，具体见`docs/refactor/runbooks/durable-cutover.md`。

Memory归档实现仍使用`DURABLE_MEMORY_SIGNAL_API_ENABLED`与`DURABLE_MEMORY_MANAGEMENT_API_ENABLED`双重显式opt-in。关闭时durable readiness不再依赖Memory schema；未来若重新纳入产品，必须先新增ADR并重新验证consent、RLS、质量和成本，不能把打开flag当成产品设计完成。

## 验证

```bash
pnpm test:web
pnpm build:web
pnpm lint:web
```
