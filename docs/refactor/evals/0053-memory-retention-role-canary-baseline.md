# Eval 0053：Memory Retention Role Canary 工程基线

- 日期：2026-08-10
- 结论：Passed；独立role、精确权限、跨workspace expiry、owner隔离与根级回归通过
- 对应迭代：[0057](../iterations/0057-memory-retention-database-role.md)

## 基线边界

该记录验证数据库部署与retention行为，不是模型质量Eval。target为一次性loopback PostgreSQL中的真实non-owner login role；seed/migration使用owner连接，清理只通过production retention runtime和专用URL执行。没有Redis、provider、真实credentials或production数据。

## 行为矩阵

| 条件 | 预期结果 |
|---|---|
| role attributes | login、BYPASSRLS；无superuser/create role/create db/inherit/replication |
| role boundary | 无membership、数据库/对象ownership、schema CREATE、sequence或清单外table权限 |
| wrong/general DB URL | config无fallback；current role verifier在ready前失败 |
| workspace A due signal + running reserved effect | signal删除；task/attempt/effect变`uncertain/source_erased`；outbox失败；content-free tombstone保留 |
| workspace B due signal | 同一实例跨workspace删除并写tombstone |
| expired active Memory | Memory和revision正文删除；content-free Memory tombstone保留 |
| expired candidate | candidate删除 |
| `SELECT jobs` | permission denied |
| clean replay | due inventory归零，实例可drain关闭 |

## 权限证据

- verifier从`DATABASE_MEMORY_RETENTION_URL`当前连接枚举所有`public` table/sequence有效权限，而不是读取某份预期grant日志；
- `SELECT/UPDATE/DELETE`对应due row lock与删除；`SELECT/UPDATE`对应extraction ledger fencing；
- outbox的`SELECT/UPDATE`对应按aggregate条件终止未发布pointer；
- tombstone的`SELECT/INSERT`由真实`ON CONFLICT DO NOTHING`失败后收敛得出；
- 清单不含principal/workspace/job/article/eval表，canary额外执行`SELECT jobs`负例。

## 当前证据

- `packages/db/tests/durable-api-role.test.ts`与`memory-retention-role.test.ts`合计6/6；
- `apps/worker/tests/memory-retention.test.ts`与`architecture.test.ts`合计15/15；
- DB与Worker TypeScript检查通过；
- `pnpm test:memory-retention-role:local` 1/1，自动创建/标记/停止并删除一次性PostgreSQL；
- 共享role engine重构后的`pnpm test:memory-api-canary:local` 1/1，证明API角色契约未回归；
- running reserved effect、两个workspace、active Memory、pending candidate和tombstone均由真实数据库断言；
- root `pnpm verify`通过：DB 129、Worker 89、FastAPI 50、Web 65，全部TypeScript、migration、Memory/Eval与workflow shadow门禁绿色；
- `pnpm check:docs`检查182份Markdown相对链接，`git diff --check`通过。

## 尚未证明

- 目标云数据库的role创建权限、TLS、连接池、网络来源限制、密码轮换和故障转移；
- 大规模due backlog下的P95/P99、WAL、autovacuum和lock等待；
- 多实例进程kill或网络分区下的恢复；已有`SKIP LOCKED`双会话基线仍有效，但本canary不重复声明进程级故障覆盖；
- write Worker、dispatcher、Eval和migration的独立角色；
- 真实模型quality/cost、retrieval或answer uplift。
