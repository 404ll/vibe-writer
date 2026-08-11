# Eval 0055：Eval Runtime Role Canary 工程基线

- 日期：2026-08-10
- 结论：Passed；三套non-owner身份、queue双连接与sampler列级ACL通过
- 对应迭代：[0059](../iterations/0059-eval-runtime-database-roles.md)

## 基线边界

该记录验证Eval数据库部署边界和队列行为，不是模型质量Eval。queue canary使用一次性loopback PostgreSQL、Redis、dispatcher/consumer两个真实non-owner login role和38-case synthetic component suite；sampler canary使用第三个non-owner role。owner连接只负责migration、role creation/provision、seed与最终断言，不进入runtime。

## 行为矩阵

| 条件 | 预期结果 |
|---|---|
| dispatcher role | `NOBYPASSRLS`，仅`outbox_events SELECT/UPDATE` |
| consumer role | `BYPASSRLS`，仅Eval claim/context/report与校准授权读取 |
| live sampler role | `BYPASSRLS`，仅policy/candidate DML与Job/Run/Article安全列读取 |
| queue `role=all` | 两个不同数据库连接，startup分别校验current role |
| Redis payload | 只有`schemaVersion + evalRunId` |
| 38-case component run | 38个trial、38个score，run原子完成 |
| dispatcher `SELECT eval_runs` | permission denied |
| consumer `SELECT outbox_events` | permission denied |
| sampler安全Article列 | 可读并可创建content-free candidate |
| sampler `SELECT articles.content`或`jobs.topic` | permission denied |
| 三个role `CREATE SCHEMA` | permission denied |

## 当前证据

- Eval配置/runtime相关测试20/20与TypeScript检查通过；
- DB role单元测试包含dispatcher、consumer和sampler精确table/column/sequence manifest；
- `pnpm test:eval-queue:local`通过：既有Redis delivery/grader 2/2，真实PostgreSQL+Redis role canary 1/1；
- `pnpm test:db:postgres:local`通过：DB 21/21、checkpoint 4/4、sampler role canary 1/1及既有component registration/enqueue断言；
- queue canary证明runtime自身verifier先于loop运行，并在两个最小权限连接上完成pointer publish、claim和report commit；
- sampler canary证明列级安全读取可用，正文、任务topic和DDL由数据库拒绝。
- root `pnpm verify`通过：DB 137、checkpoint runtime 10、Worker 91、FastAPI 50、Web 65，全部TypeScript、migration、Memory/Eval、workflow shadow、lint与Next production build门禁绿色；
- `pnpm check:docs`检查189份Markdown相对链接，`git diff --check`通过。

## 尚未证明

- 目标云数据库的TLS、连接池、网络来源限制、密码轮换、故障转移与托管告警；
- dispatcher/consumer拆成独立进程后的吞吐、P95/P99与滚动发布；
- Redis/PostgreSQL网络分区、OS kill和真实provider smoke；
- migration、人工register/enqueue/authorization CLI、CI artifact与运维查询角色；
- 真实judge质量/成本、Memory calibration账单或retrieval answer uplift。
