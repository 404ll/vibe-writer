# @vibe-writer/db

`packages/db` 是 Next.js API 与 Node Worker 共用、且唯一的 PostgreSQL 数据边界。

## 当前内容

- `src/schema.ts`：job/run/event/effect/outbox/checkpoint、interrupt/command、article/version、trace 与 eval 的 Drizzle schema 和数据库约束；
- `src/repositories/jobs.ts`：幂等创建、事务内 outbox、token-fenced claim/heartbeat/cancel/settle、run event 与 effect journal；
- `src/repositories/terminals.ts`：completed article/done、failed/cancelled event 与 awaiting-input 的 fenced transaction；
- `src/repositories/commands.ts`：single-command outline reply、payload collision、requeue + resume outbox transaction；
- `src/repositories/traces.ts`：按 run 读取版本快照和有界 provider span；
- `src/repositories/evals.ts`：versioned suite/case、inline/queued run、lease/fencing、原子 trial/score report 与离线报告持久化；
- `src/repositories/eval-candidates.ts`：不读取正文的 completed-run sampler、consent/retention、workspace review、expiry 与 append-only governance event；
- `src/postgres-role-contract.ts`：共享的精确有效权限、角色属性、ownership与schema verifier/provisioning引擎；
- `src/durable-api-role.ts` / `src/memory-retention-role.ts`：公开HTTP与跨workspace retention各自独立的机器可读数据库角色契约；
- `drizzle/`：可提交、可审查的 PostgreSQL migration 与 snapshot；
- `tests/jobs.integration.test.ts`：用 PGlite 执行空库与 populated forward migration、约束和快速 repository 回归；
- `tests/postgres.integration.test.ts`：用两个独立 PostgreSQL backend session 验证 row-lock claim、event seq/idempotency、effect reservation 与 takeover fencing。

Iteration 0009 起，`queued → running` 和 running terminal transition 需要 claim/fencing；通用 `transitionJob()` 不允许绕过 running lease。Iteration 0010 又移除了 generic optional-run event append：run progress event 必须携带有效 lease identity 和 job-scoped idempotency key。Worker 只通过 terminal repository 原子提交 article、terminal event 与 job/run 状态。`run_effects` 对外部调用提供 reserve/finish/uncertain journal，但不宣称 exactly-once。`trace_spans`只保存可查询的 provider/model/token/latency 等有界元数据。

PGlite 只用于快速验证 PostgreSQL 语义。真实多连接 suite 用本机 PostgreSQL 验证 row lock 与 takeover，但仍不替代托管 PostgreSQL、连接池代理、网络故障或进程 kill 测试。suite 会执行 migration 与 `TRUNCATE`，因此只接受 local harness 创建并以随机名称/comment 标记的一次性 loopback database。

## 常用命令

从仓库根目录运行：

```bash
pnpm test:db
pnpm typecheck:db
pnpm check:migrations
pnpm test:db:postgres:local
```

修改 schema 后：

```bash
pnpm --filter @vibe-writer/db generate
pnpm check:migrations
pnpm test:db
```

CI 不能把共享 PostgreSQL URL 直接传给 `test:postgres`。需要由 CI provisioner 创建名称为 `vibe_writer_integration_<32位hex id>` 的一次性 loopback database、写入 `vibe-writer-ephemeral:<同一id>` database comment，并同时设置 `TEST_DATABASE_URL` 与 `VIBE_WRITER_POSTGRES_TEST_ID`；普通开发默认使用 `pnpm test:db:postgres:local` 完成这些保护步骤。

必须审查生成的 SQL 和 snapshot，不能用 `push` 绕过 migration history。生产代码通过 `createPostgresDatabase(connectionString)` 创建连接，并在进程关闭时调用返回的 `close()`。

## 尚未建立的边界

- 面向多用户的正式 auth provider；
- reconciler、托管 PostgreSQL fault test 与收费 provider smoke；
- checkpoint retention/encryption 与 effect-specific resolver；
- thread、memory、RAG、automatic live scanner/materializer、grader 与 observability vendor adapter。

这些能力按 `docs/refactor/roadmap.md` 的后续迭代加入，不在本包中提前伪造实现。
