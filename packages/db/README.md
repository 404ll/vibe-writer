# @vibe-writer/db 数据库边界

`packages/db` 是 Next.js 接口与 Node.js 工作进程共用、且唯一的 PostgreSQL 数据边界。

## 数据心智模型

| 数据 | 回答的问题 | 主要写入者 |
|---|---|---|
| 任务 | 用户想做的任务现在处于什么状态 | 网页端创建，工作进程推进 |
| 运行记录 | 某一次执行使用了哪些版本、由谁领取、结果如何 | 工作进程 |
| 事务发件箱 | 哪个已提交事实还需要异步投递 | 网页端或终态事务创建，调度器结算 |
| 事件 | 界面可以按什么顺序重放进度 | 当前持有租约的工作进程 |
| 检查点尝试与指针 | 接管后从哪个 LangGraph 状态继续 | 工作进程与检查点适配器 |
| 外部调用与追踪片段 | 模型或搜索调用是否完成、结果是否不确定 | 工作进程外部调用账本 |
| 文章与版本 | 用户最终可读、可编辑、可恢复的内容 | 终态事务与网页端 |

PostgreSQL 是这些业务事实的唯一来源。Redis 队列里即使没有消息，只要还有等待处理的事务发件箱记录，就能重新投递；浏览器即使断线，事件也能重新读取。

## 四个核心不变量

1. **任务与事务发件箱同事务**：不允许出现已接受但永远没入队的任务。
2. **运行中写入必须受隔离令牌保护**：事件、外部调用、检查点指针与终态都要匹配当前 `leaseToken`。
3. **终态原子提交**：文章、终态事件与任务/运行记录状态一起成功或一起失败。
4. **工作区作用域在数据库生效**：网页身份校验不能替代行级安全或专用数据库角色。

写作主状态机是 `queued → running → completed`；大纲中断走 `running → awaiting_input → queued → running`，失败与取消分别进入 `failed` / `cancelled` 终态。运行中的推进不能调用通用状态更新绕过租约。

## 当前内容

- `src/schema.ts`：任务、运行记录、事件、外部调用、事务发件箱、检查点、命令、文章、追踪与评测的 Drizzle 数据结构和数据库约束；
- `src/repositories/jobs.ts`：幂等创建、事务内发件箱、受隔离令牌保护的领取/心跳/取消/结算、运行事件与外部调用账本；
- `src/repositories/outbox.ts`：`SKIP LOCKED` 批量领取、发布租约、失败退避和过期锁回收；
- `src/repositories/terminals.ts`：文章完成、失败、取消和等待输入的受保护终态事务；
- `src/repositories/commands.ts`：单条大纲回复、消息体冲突、重新排队与恢复发件箱事务；
- `src/repositories/traces.ts`：按运行记录读取版本快照和有界供应商追踪片段；
- `src/repositories/evals.ts`：版本化评测套件/样例、同步或排队运行、租约与隔离、原子试验/评分报告及离线报告持久化；
- `src/repositories/eval-candidates.ts`：不读取正文的已完成运行采样、授权与保留期、工作区复核、过期和只追加治理事件；
- `src/postgres-role-contract.ts`：共享的精确有效权限、角色属性、所有权与数据结构校验/配置引擎；
- `src/durable-api-role.ts` / `src/memory-retention-role.ts`：公开接口与跨工作区保留期维护各自独立的机器可读数据库角色契约；
- `drizzle/`：可提交、可审查的 PostgreSQL 迁移与快照；
- `tests/jobs.integration.test.ts`：用 PGlite 执行空库与已有数据的前向迁移、约束和快速数据仓储回归；
- `tests/postgres.integration.test.ts`：用两个独立 PostgreSQL 后端会话验证行锁领取、事件序号/幂等、外部调用预留与租约接管隔离。

从迭代 0009 起，`queued → running` 和运行中终态转换必须经过领取与隔离校验；通用 `transitionJob()` 不允许绕过运行租约。从迭代 0010 起，运行进度事件必须携带有效租约身份和任务级幂等键。工作进程只通过终态数据仓储原子提交文章、终态事件与任务/运行记录状态。`run_effects` 对外部调用提供预留、完成和结果不确定账本，但不宣称“恰好执行一次”。`trace_spans` 只保存可查询的供应商、模型、令牌数量和延迟等有界元数据。

PGlite 只用于快速验证 PostgreSQL 语义。真实多连接测试组使用本机 PostgreSQL 验证行锁与接管，但仍不能替代托管 PostgreSQL、连接池代理、网络故障或进程强制终止测试。测试组会执行迁移与 `TRUNCATE`，因此只接受本地测试工具创建并以随机名称和备注标记的一次性回环数据库。

## 常用命令

从仓库根目录运行：

```bash
pnpm test:db
pnpm typecheck:db
pnpm check:migrations
pnpm test:db:postgres:local
```

修改数据结构后：

```bash
pnpm --filter @vibe-writer/db generate
pnpm check:migrations
pnpm test:db
```

持续集成不能把共享 PostgreSQL 连接地址直接传给 `test:postgres`。持续集成准备器需要创建名称为 `vibe_writer_integration_<32位十六进制标识符>` 的一次性回环数据库，写入 `vibe-writer-ephemeral:<同一标识符>` 数据库备注，并同时设置 `TEST_DATABASE_URL` 与 `VIBE_WRITER_POSTGRES_TEST_ID`；普通开发默认使用 `pnpm test:db:postgres:local` 完成这些保护步骤。

必须审查生成的 SQL 和快照，不能用 `push` 绕过迁移历史。生产代码通过 `createPostgresDatabase(connectionString)` 创建连接，并在进程关闭时调用返回的 `close()`。

## 当前最小可行产品边界

- 面向多用户的正式身份认证供应商；
- 托管 PostgreSQL 故障演练与收费供应商冒烟测试；
- 检查点保留期、加密与外部调用专用结果解析器；
- 可观测性平台适配器；
- 长期记忆与检索增强生成已经明确延后，不属于当前写作产品链路。

这些能力只有在真实产品需求出现后才扩展，不在当前最小可行产品中提前接回运行时。
