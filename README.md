# Vibe Writer

Vibe Writer 是一个全部使用 TypeScript 构建的人工智能长文写作最小可行产品。用户提交主题后，系统生成并确认大纲，完成资料搜索、逐章写作和审稿，最后把文章及其历史版本持久化到 PostgreSQL。

Python 与 FastAPI 兼容运行时已经退役。当前只有一条产品链路：

```text
Next.js 网页与接口
  → PostgreSQL 任务 + 事务发件箱
  → BullMQ / Redis 队列
  → TypeScript 工作进程 + LangGraph.js
  → PostgreSQL 事件 / 检查点 / 文章
  → Next.js 服务端推送 / 文章界面
```

## 先建立心智模型

把系统先理解成四个角色：

| 角色 | 它回答的问题 | 事实存在哪里 |
|---|---|---|
| Next.js | 用户提交了什么、现在看到什么 | 只通过 PostgreSQL 数据仓储读写 |
| PostgreSQL | 任务、运行记录、事件、检查点和文章现在是什么状态 | 它自己；这是唯一业务事实来源 |
| BullMQ 与 Redis | 哪个任务应该尽快交给哪个工作进程 | 只保存投递和重试状态，不拥有业务结果 |
| TypeScript 工作进程 | 长任务具体怎么执行、何时暂停或恢复 | 执行过程持续写回 PostgreSQL |

一次任务的关键不是“接口直接调用工作进程”，而是“接口先可靠记账，工作进程稍后接单”：

1. `POST /api/durable/jobs` 在一个 PostgreSQL 事务里写入任务与事务发件箱记录。
2. 调度器从事务发件箱读取待投递意图，把 `jobId` 放入 BullMQ。
3. 消费者收到消息后还要去 PostgreSQL 领取租约；队列消息本身不代表执行权。
4. LangGraph.js 执行节点，并把事件、检查点与外部调用账本写回 PostgreSQL。
5. 完成时，文章、完成事件与任务/运行记录终态在一个终态事务中提交。
6. 浏览器通过服务端推送按事件 `_seq` 重放；刷新或断线不会依赖工作进程内存恢复界面。

三个最重要的取舍：

- **事务发件箱**解决“任务已写入，但发布队列前进程崩溃”的丢任务窗口。代价是系统按“至少投递一次”设计，所有执行边界都必须幂等。
- **租约与隔离令牌**解决旧工作进程失联后又恢复并覆盖新结果的问题。数据库而不是 BullMQ 决定谁有写权限。
- **检查点不等于长期记忆**：检查点只恢复一次写作任务；长期用户记忆已从当前最小可行产品延后。

推荐按这条顺序读代码：

1. [`apps/web/README.md`](./apps/web/README.md)：网页接口、服务端推送与界面边界；
2. [`packages/contracts/README.md`](./packages/contracts/README.md)：跨运行时协议；
3. [`packages/db/README.md`](./packages/db/README.md)：业务事实和事务不变量；
4. [`apps/worker/README.md`](./apps/worker/README.md)：队列、租约与常驻执行；
5. [`packages/workflow-runtime/README.md`](./packages/workflow-runtime/README.md)：LangGraph 状态图；
6. [`packages/agent-core/README.md`](./packages/agent-core/README.md)：写作领域组件。

## 运行边界

- `apps/web`：Next.js 应用路由，负责页面、路由处理器、服务端推送和文章读写；可部署到 Vercel。
- `apps/worker`：常驻 Node.js 进程，负责 BullMQ、LangGraph.js、模型和搜索调用；部署在长期运行的服务器或容器平台。
- `packages/db`：PostgreSQL、Drizzle 数据结构、迁移、行级安全和持久化数据仓储。
- `packages/contracts`：网页端、工作进程与评测共用的 Zod 契约。
- `packages/provider-runtime`：Anthropic 与 Tavily 等基础设施适配器，把外部开发工具包转换成领域接口。
- `packages/agent-core`、`packages/workflow-runtime`：不依赖网页接口、数据库或供应商开发工具包的智能体领域逻辑。
- `apps/eval`、`packages/eval-*`：版本化回归评测。长期记忆实验代码已归档，默认不进入产品运行路径。

Vercel 只承载网页与接口。BullMQ 工作进程需要持续监听 Redis，不能作为常驻进程放进 Vercel 函数。网页接口与工作进程必须访问同一套 PostgreSQL；工作进程的调度器与消费者访问同一套 Redis。PostgreSQL 是事实来源，Redis 只负责分发、重试和并发控制。

## 本地最小可行产品

前置条件：Node.js 22 及以上版本、pnpm 10、Docker，以及可用的 Anthropic 密钥。Tavily 密钥仅在需要联网搜索时使用。

```bash
cp .env.example .env
pnpm install
pnpm dev:durable
```

`pnpm dev:durable` 会启动本地 PostgreSQL、Redis、Next.js 与 TypeScript 工作进程，并使用只允许在开发环境运行的固定单用户身份。打开 <http://127.0.0.1:3000>。

停止应用后，本地数据库数据卷默认保留：

```bash
pnpm dev:durable:down
```

## Vercel 预览部署

推荐先部署受保护的预览环境，而不是直接开放生产环境：

1. Vercel 项目的根目录选择 `apps/web`，并保持“包含根目录以外的源文件”开启。
2. 开启 Vercel 身份验证，保护预览部署。
3. 按 [`apps/web/.env.example`](./apps/web/.env.example) 配置预览环境变量。
4. 使用可从 Vercel 与工作进程主机访问的 PostgreSQL，并把 `DATABASE_API_URL` 设置为专用非所有者接口角色。
5. 在独立服务器启动工作进程；工作进程使用自己的调度器/消费者数据库角色、Redis 和模型凭据。

完整顺序见 [`docs/refactor/runbooks/vercel-preview.md`](./docs/refactor/runbooks/vercel-preview.md)。当前 `protected-single-user` 身份模式只允许在 Vercel 预览环境中使用；它要求部署保护已开启，不能作为公开生产认证。

## 常用命令

```bash
pnpm dev:durable
pnpm test:durable-product:local
pnpm test:worker:production:local
pnpm test:web
pnpm build:web
pnpm verify
```

`pnpm verify` 执行 TypeScript 契约、智能体、工作流、数据库、工作进程、评测、网页端、代码规范、构建和文档检查。需要真实 PostgreSQL、Redis 或 Docker 的重型组合验证使用单独命令运行。

## 关键环境变量

Vercel 网页与接口：

- `NEXT_PUBLIC_API_BASE=/api/durable`
- `DURABLE_API_ENABLED=true`
- `DATABASE_API_URL`
- `DURABLE_AUTH_MODE=protected-single-user`
- `DURABLE_EXTERNAL_ACCESS_PROTECTION=true`
- `DURABLE_SINGLE_USER_PRINCIPAL_ID`
- `DURABLE_SINGLE_USER_WORKSPACE_ID`

常驻工作进程：

- `DURABLE_WORKER_ENABLED=true`
- `DATABASE_WRITE_DISPATCHER_URL` / `WRITE_DISPATCHER_DATABASE_ROLE`
- `DATABASE_WRITE_CONSUMER_URL` / `WRITE_CONSUMER_DATABASE_ROLE`
- `REDIS_URL`
- `ANTHROPIC_API_KEY`
- `TAVILY_API_KEY`（可选）
- `WEB_SEARCH_PROVIDER=disabled|tavily|brave|searxng`（可选；未设置时按已提供配置自动选择）
- `BRAVE_SEARCH_API_KEY` 或 `SEARXNG_URL`（选择对应搜索供应商时使用）
- `WEB_EXTRACT_ENABLED=true|false`（默认开启本地 Readability 网页正文提取）

更多设计、架构决策记录、迭代和验证证据统一在 [`docs/refactor`](./docs/refactor/README.md)。
