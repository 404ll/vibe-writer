# Iteration 0004：Durable Job 数据层基础

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R3 Durable data
- 对应决策：[ADR-0003](../decisions/0003-postgres-source-of-truth.md)、[ADR-0005](../decisions/0005-durable-job-state-and-event-ordering.md)

## 目标

建立可供 Next.js API 与 Node Worker 共用的 PostgreSQL/Drizzle 数据包，先用 migration 和 repository 测试证明 job、run、event 与 outbox 的核心不变量，不改变当前 FastAPI 运行路径。

## 范围内

- 新增 `packages/db` 与 Drizzle PostgreSQL schema；
- 首批表：`jobs`、`runs`、`job_events`、`outbox_events`；
- 生成并提交 SQL migration 和 Drizzle snapshot；
- 实现幂等 job 创建、事务内 outbox、条件状态转移、原子 event seq 和 replay repository；
- 使用 PGlite 执行 migration、约束与 repository 集成测试；
- 增加根级 db test/typecheck/migration-check 命令；
- 同步系统设计、路线图和维护说明。

## 范围外

- 不把 FastAPI endpoint 切到 PostgreSQL；
- 不启动 BullMQ/Redis 或 Worker；
- 不迁移文章与历史版本数据；
- 不加入 LangGraph checkpointer、memory、RAG 或 eval 表；
- 不声称 PGlite 已证明真实多连接锁竞争；
- 不决定登录、多租户或 PostgreSQL 托管厂商。

## 必须证明的不变量

1. 同一 idempotency key 只创建一个 job 和一条 enqueue outbox；
2. job 与 outbox 在同一事务成功或失败；
3. 同一 job 的 event seq 唯一、连续并按序重放；
4. replay 支持 `afterSeq` 游标且不会返回旧事件；
5. terminal job 不能通过 repository 回到 running；
6. run attempt 在 job 内唯一，非法数值和非法 row shape 被数据库拒绝；
7. migration history 通过 `drizzle-kit check`。

## 实施结果

新增 `packages/db`，并明确分为四层：

- `src/schema.ts`：PostgreSQL schema、索引、外键与 `CHECK` 约束；
- `src/repositories/jobs.ts`：面向 API/Worker 的事务和状态机边界；
- `drizzle/`：首个 SQL migration、snapshot 与 journal；
- `tests/jobs.integration.test.ts`：使用 PGlite 从空数据库执行 migration 后验证 repository。

首个 migration 建立：

| 表 | 当前责任 |
|---|---|
| `jobs` | 请求幂等、生命周期、工作阶段、event cursor、取消/lease/heartbeat 投影 |
| `runs` | attempt 唯一性及 model/prompt/graph/tool/code 版本快照 |
| `job_events` | `(job_id, seq)` 顺序真相和 SSE replay 数据 |
| `outbox_events` | 与 job 同事务产生的待投递消息 |

Repository 已实现：

- 重复 idempotency key 返回第一次创建的 job，不重复产生 enqueue outbox；
- job insert 与 outbox insert 使用同一事务；
- 状态变更同时校验 expected status，terminal 状态无法复活；
- `awaiting_input → running` 保留第一次 `started_at`；
- event append 在事务内原子递增 `next_event_seq`，再写入同一序号事件；
- replay 使用 `afterSeq` 开区间并按 seq 升序返回。

> 后续演进：Iteration 0009 / ADR-0010 收紧了执行状态入口。`queued → running`、heartbeat 和 running terminal transition 现在必须经过 token-fenced claim/settle；本节记录的是 R3 当时的基础接口，不代表当前仍允许通用 transition 绕过 Worker lease。

生产连接使用 `postgres` adapter；PGlite 只存在于 dev/test dependency。包使用方式和迁移流程见 [`packages/db/README.md`](../../../packages/db/README.md)。

## 验证证据

```bash
pnpm test:db
pnpm typecheck:db
pnpm check:migrations
pnpm test:contracts
pnpm typecheck:contracts
git diff --check
```

实际结果：

| 命令 | 结果 |
|---|---|
| `pnpm test:db` | 通过，1 个文件、8 项 migration/constraint/repository 测试 |
| `pnpm typecheck:db` | 通过 |
| `pnpm check:migrations` | 通过，`drizzle-kit check` 返回 `Everything's fine` |
| `pnpm test:contracts` | 通过，2 个文件、11 项测试 |
| `pnpm typecheck:contracts` | 通过 |
| `pnpm lint:web` | 通过 |
| `pnpm test:web` | 通过，6 个文件、12 项测试 |
| `pnpm build:web` | 通过，Next.js 生产构建生成 `/` 与 `/articles/[id]` |
| `git diff --check` | 通过 |

`pnpm test:api` 在当前 worktree 首先因为缺少 `../../.venv/bin/python` 未进入 pytest。改用主检出目录已有虚拟环境后，41 项中 30 项通过、11 项失败；失败仍集中在既有 Anthropic `MagicMock` 内容块无法被 `_extract_text_from_content` 识别，本迭代没有修改对应 Python Agent 路径。

### 首次失败与修正

1. `pnpm typecheck:db` 首次发现测试 helper 把默认 UUID 推导成过窄的 template literal 类型；已把参数显式声明为 `string`。
2. Repository 首次错误地使用 Zod output 类型作为创建输入，导致带默认值的 `style`/`intervention` 在调用前变成必填；contracts 现在同时导出 `z.input` 类型，repository 解析后再使用 output。
3. 实现审阅发现 resume 会重写 `started_at`；现只在 `queued → running` 时写入，并用暂停/恢复测试锁定语义。

## 回滚

当前运行时尚未读取 `packages/db`，因此代码回滚不会影响 FastAPI/SQLite 数据，也无需双写恢复。

如果 migration 只应用在一次性测试数据库，可按依赖逆序删除 `job_events`、`runs`、`outbox_events`、`jobs` 后重建测试库。若未来已应用到共享或生产 PostgreSQL，不删除 migration history，也不手工修改 Drizzle journal；应新增 forward compensating migration，在确认没有新路径写入后再删除表或列。

## 剩余风险

- PGlite 证明 migration 和单数据库事务语义，但没有证明真实 PostgreSQL 多连接下的 row lock、event append 竞争和隔离级别行为；
- 尚未实现 outbox claim/publish、Worker lease、heartbeat 和 reconciler；
- Next.js 与 FastAPI 尚未接入这些表，因此服务重启恢复能力还没有改变；
- namespace、tenant、RLS、article、checkpoint、memory 和 eval schema 都仍未决定；
- 根级 `pnpm test:api` 在隔离 worktree 需要独立环境初始化，且现有 Agent mock 测试仍非全绿。

## 文档读者测试

以不了解实现的读者可能提出的七个问题复核 ADR、系统设计与本记录：

1. **当前线上/本地运行时已经使用 PostgreSQL 了吗？** 没有；当前事实、范围外和剩余风险都明确仍由 FastAPI/SQLite/内存承载。
2. **`status` 与 `stage` 为什么分开？** ADR-0005 明确一个描述生命周期，一个描述写作步骤。
3. **并发追加事件怎样分配 seq？** ADR 和实施结果都说明在事务内原子更新 job cursor，并由复合主键最终防重。
4. **重复创建是否会重复投递？** job 与 enqueue outbox 同事务，idempotency key 唯一，测试证明只各有一条。
5. **PGlite 证明了什么、没证明什么？** 测试边界和剩余风险分别列出 PostgreSQL 语义与真实多连接/网络边界。
6. **运行版本能否追溯？** `runs` 已要求 model、prompt、graph、tool、code revision；实际 Worker 写入将在后续迭代接入。
7. **如果方案要撤回怎么办？** 回滚章节区分了未切流、一次性测试库和已应用共享数据库三种情况。

上述答案均能从权威文档直接定位，无需从代码猜测，Iteration 0004 满足 R3 退出条件。
