# Eval 0054：Write Runtime Role Canary 工程基线

- 日期：2026-08-10
- 结论：Passed；双非owner身份、checkpoint DDL分离、完整production projection与权限负例通过
- 对应迭代：[0058](../iterations/0058-write-runtime-database-roles.md)

## 基线边界

该记录验证数据库部署、BullMQ delivery和durable Worker行为，不是模型质量Eval。target为一次性loopback PostgreSQL中的dispatcher/consumer两个真实non-owner login role和一次性Redis；owner连接只执行Drizzle migration、LangGraph checkpoint setup、role creation/provision和测试seed/assertion。provider为本地Anthropic wire fixture，不读取真实credentials或产生费用。

## 行为矩阵

| 条件 | 预期结果 |
|---|---|
| dispatcher role | `NOBYPASSRLS`，仅`outbox_events SELECT/UPDATE` |
| consumer role | `BYPASSRLS`，仅durable execution public DML与checkpoint schema DML |
| `DURABLE_WORKER_ROLE=all` | 建立两个独立数据库连接，不合并role |
| runtime startup | 两个current-role verifier和schema检查先于ready；不调用`saver.setup()` |
| completed + outline resume | outbox发布、checkpoint恢复、terminal Article与done projection一致 |
| running cancellation | provider abort、cancelled terminal与effect/trace收敛一致 |
| provider 5xx | bounded retry后failed terminal、effect和trace一致 |
| expired lease takeover | 旧lease被fence，新run完成且projection一致 |
| dispatcher `SELECT jobs` | permission denied |
| consumer `SELECT outbox_events` | permission denied；仍可按职责`INSERT` |
| 两个role `CREATE SCHEMA` | permission denied |
| consumer执行checkpoint `setup()` | permission denied |

## 当前证据

- DB role/unit与repository tests 133/133；
- Worker unit/integration/architecture tests 91/91；
- DB、Worker和checkpoint runtime TypeScript检查通过；
- `pnpm test:worker:production:local` 5/5：一次性PostgreSQL、Redis、两个非owner角色、五类projection和权限负例全部通过；
- 同一harness内`pnpm build:web`通过；
- `pnpm test:memory-api-canary:local`与`pnpm test:memory-retention-role:local`再次通过，证明共享schema-aware verifier没有回归既有role边界；
- root `pnpm verify`通过：DB 133、checkpoint runtime 10、Worker 91、FastAPI 50、Web 65，全部TypeScript、migration、Memory/Eval与workflow shadow门禁绿色；
- `pnpm check:docs`检查185份Markdown相对链接，`git diff --check`通过。

## 尚未证明

- 目标云数据库的role创建权限、TLS、连接池、网络来源限制、密码轮换和故障转移；
- 多进程而非`role=all`单进程部署下的P95/P99、pool预算与滚动发布；
- OS kill、Redis/PostgreSQL网络分区与真实provider smoke；
- Eval dispatcher/consumer/sampler与migration的独立角色；
- 真实模型quality/cost、Memory retrieval或answer uplift。
