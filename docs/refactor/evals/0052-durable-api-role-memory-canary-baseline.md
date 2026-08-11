# Eval 0052：Durable API Role 与 Memory Canary 工程基线

- 日期：2026-08-10
- 结论：Passed；精确数据库权限、真实Next runtime、动态路由、proxy header stripping、RLS与Memory角色矩阵通过
- 对应迭代：[0056](../iterations/0056-durable-api-role-and-memory-canary.md)

## 基线边界

该记录是部署协议工程基线，不是模型质量Eval。目标实现为production build的Next.js App Router；数据库为一次性真实PostgreSQL；HTTP入口为loopback header-stripping proxy；身份由固定测试session映射注入，不调用真实认证供应商。

## 行为矩阵

| 条件 | 预期结果 |
|---|---|
| API角色属性 | login；无superuser/create role/create db/inherit/replication/BYPASSRLS |
| API角色边界 | 无其他role membership、数据库/对象ownership、schema CREATE |
| table/sequence权限 | 与versioned清单完全相等；缺失或额外均失败 |
| 客户端仅伪造`x-vibe-*` | proxy删除header；Next返回401 |
| 已知principal + 非membership workspace | 403，repository不执行业务读取 |
| viewer session + 伪造owner header | proxy覆盖为viewer；candidate/shared signal/active delete均403 |
| editor | candidate可读且可materialize；无active delete |
| owner | active Memory可硬删除，receipt不含正文/fingerprint |
| outsider workspace | active集合为空，不读取其他workspace |
| viewer personal signal | 201创建并可撤回；shared subject仍403 |
| dynamic review/delete route | 由Next Route Handler处理，不回退FastAPI |

## 权限证据

- provisioning先撤销`PUBLIC` schema CREATE和API角色当前全部schema/table/sequence直接授权，再按清单重授；
- verifier从`DATABASE_API_URL`当前连接枚举所有`public`表的七类有效权限和所有sequence的三类有效权限；
- verifier额外查询角色属性、role membership、对象/数据库ownership和schema USAGE/CREATE；
- canary实际触发candidate row lock/materialize、Memory删除、signal row lock/tombstone/outbox update/source delete，因此不是只读权限探针；
- `memory_source_signals.UPDATE`由`SELECT FOR UPDATE`真实失败证据引入，其余表没有因此获得全CRUD。

## 当前证据

- `packages/db/tests/durable-api-role.test.ts` 3/3；完整DB 126/126；
- `pnpm test:memory-api-canary:local` 1/1；命令内部完成`pnpm build:web`并启动真实`next start`；
- readiness由API role连接返回200；HTTP矩阵全部通过；
- 根级`pnpm verify`通过：DB 126、Worker 87、FastAPI 50、Web 65及全部Memory/Eval/Workflow门禁绿色；
- `pnpm check:docs`检查179份Markdown链接，`git diff --check`通过；
- canary结束后主动停止Next、proxy与PostgreSQL并删除临时目录；
- 没有provider调用、credentials读取、Redis/Worker启动或production数据写入。

## 尚未证明

- 托管Ingress/CDN是否清除header、Next是否只有私网入口、真实session是否正确映射principal/workspace；
- API role在目标云数据库的密码轮换、连接池、TLS和故障转移；
- Worker、migration、dispatcher、retention与Eval maintenance的独立最小权限角色；
- 真实模型quality/cost、Memory retrieval和answer uplift；
- 高并发与真实数据规模下的锁等待、连接池容量和P95/P99延迟。
