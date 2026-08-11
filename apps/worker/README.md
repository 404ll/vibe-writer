# @vibe-writer/worker 工作进程

`apps/worker` 是独立于 Next.js 的常驻 Node.js 运行时。它把 PostgreSQL 中已记账的异步意图搬进 BullMQ，领取数据库执行权，再驱动 LangGraph.js 直到暂停或进入终态。

## 两个角色

| 角色 | 输入 | 负责 | 数据库权限边界 |
|---|---|---|---|
| 调度器 | PostgreSQL 事务发件箱 | 发布 BullMQ 消息、失败退避、标记已发布 | 只读写 `outbox_events` |
| 消费者 | BullMQ 消息 | 领取任务、执行工作流、发送心跳、提交检查点/事件/文章 | 只访问写作执行所需表与检查点数据结构 |

`DURABLE_WORKER_ROLE=dispatcher|consumer|all` 决定进程启用哪些角色。`all` 只是把两者放在一个 Node.js 进程，仍建立两个数据库连接并拒绝相同连接地址或角色。

## 一条消息怎么执行

1. `outbox-dispatcher.ts` 领取事务发件箱记录，把最小消息 `{ schemaVersion, jobId }` 发布到 BullMQ。
2. `bullmq-adapter.ts` 负责 Redis 传输、队列重试和并发，不解释业务状态。
3. `runner.ts` 再去 PostgreSQL 领取任务，取得 `runId + leaseToken`；领取失败就不执行。
4. `workflow-executor.ts` 创建或重放受隔离令牌保护的检查点，运行 LangGraph，并处理大纲中断与回复。
5. `workflow-services.ts` 把纯智能体组件接到供应商接口；`effect-journal.ts` 为外部调用保留有界账本。
6. `runner.ts` 用同一个隔离令牌进入终态数据仓储，原子提交文章、事件和任务/运行记录终态。

## 为什么 BullMQ 不是事实来源

BullMQ 提供快速投递、退避、并发和停滞检测。事务发件箱发布可能重复，BullMQ 消息也可能重试，所以系统按“至少投递一次”设计：

- 稳定的队列任务标识尽量压缩重复消息；
- PostgreSQL 租约决定当前工作进程是否拥有执行权；
- 隔离令牌阻止过期工作进程写入；
- 检查点避免接管后从头调用模型；
- 终态事务防止“文章已写但任务仍显示运行中”。

## 任务状态机

```text
正常完成：排队中 → 运行中 → 已完成
人工确认：运行中 → 等待输入 → 排队中 → 运行中
异常终止：排队中 / 运行中 / 等待输入 → 失败或已取消
```

数据库中的实际状态值分别是 `queued`、`running`、`awaiting_input`、`completed`、`failed` 和 `cancelled`。等待输入表示 LangGraph 已持久化大纲中断并主动释放执行租约；用户回复会把恢复命令与新的事务发件箱记录一起提交，再由正常队列链路恢复。任何离开运行中状态的写入都必须经过当前隔离令牌校验。

## 核心文件

| 文件 | 阅读重点 |
|---|---|
| `src/production.ts` | 生产环境组合入口；所有基础设施在这里装配 |
| `src/process-runtime.ts` | 启动顺序、调度器轮询、排空与关闭顺序 |
| `src/outbox-dispatcher.ts` | PostgreSQL 到 BullMQ 的“至少投递一次”桥接 |
| `src/bullmq-adapter.ts` | 队列传输与可重试/不可恢复错误映射 |
| `src/runner.ts` | 租约、心跳、中止信号与终态结算 |
| `src/workflow-executor.ts` | 检查点、LangGraph 调用/重放与中断恢复 |
| `src/effect-journal.ts` | 模型/搜索副作用的预留与结果不确定语义 |
| `src/config.ts` | 默认拒绝的环境配置和角色分离 |

如果任务创建后一直是 `queued`，按这个顺序缩小范围：

1. 看工作进程 `/ready` 是否返回 200，以及结构化日志中是否有 `outbox.dispatch`、`bullmq.error` 或 `bullmq.failed:*`；
2. 读 `packages/db/src/repositories/jobs.ts` 和 `outbox.ts`，确认事务发件箱记录是否创建、是否处于待发布或发布中状态，以及是否正在重试；
3. 读 `src/production.ts` 与 `src/process-runtime.ts`，确认调度器和消费者均已启动；
4. 读 `src/outbox-dispatcher.ts` 与 `src/bullmq-adapter.ts`，确认 Redis 投递；
5. 最后读 `src/runner.ts` 与数据库领取逻辑，判断消费者是否因忙碌、等待输入、已终止或租约条件拒绝执行。

## 运行与部署

本地完整产品从仓库根目录运行 `pnpm dev:durable`。生产工作进程使用：

```bash
pnpm start:worker
```

必需配置包括：

- `DURABLE_WORKER_ENABLED=true`
- `DURABLE_WORKER_ROLE=dispatcher|consumer|all`
- `DATABASE_WRITE_DISPATCHER_URL` / `WRITE_DISPATCHER_DATABASE_ROLE`
- `DATABASE_WRITE_CONSUMER_URL` / `WRITE_CONSUMER_DATABASE_ROLE`
- `REDIS_URL`
- 消费者所需的 `ANTHROPIC_API_KEY`、`MODEL_ID`；`TAVILY_API_KEY` 可选

托管 PostgreSQL 不允许消费者使用 `BYPASSRLS` 时，个人预览部署可使用 `WRITE_CONSUMER_ACCESS_MODE=single-workspace`，并通过连接启动参数固定 `app.workspace_id`。这只适用于受保护的单工作区部署，不是多租户生产认证方案。

设置 `WORKER_HEALTH_PORT` 后提供 `/live` 与 `/ready`。就绪检查会先验证当前数据库身份、精确权限、工作区会话作用域、业务/检查点数据结构与 BullMQ 角色；关闭时会先进入排空状态再停止消费。

部署顺序与环境变量见 [`docs/refactor/runbooks/vercel-preview.md`](../../docs/refactor/runbooks/vercel-preview.md)。长期记忆工作进程与保留期维护代码是默认关闭的归档模块，不进入当前产品最小可行版本。

## 验证

```bash
pnpm --filter @vibe-writer/worker test
pnpm --filter @vibe-writer/worker typecheck
pnpm test:worker:production:local
```
