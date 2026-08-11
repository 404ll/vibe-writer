# ADR-0058：Memory Retention 独立数据库角色

- 状态：Accepted
- 日期：2026-08-10

## 背景

Iteration 0052已经把Memory retention做成独立DB-only进程，但仍读取通用`DATABASE_URL`。Iteration 0056只约束公开Durable API角色，明确不允许retention复用该连接。若maintenance继续使用owner/migration连接，RLS、对象ownership和全库DDL能力会让一次清理缺陷扩大到整个数据库；若直接使用普通非owner角色，当前全局due扫描又会因没有终端用户workspace session而看不到任何RLS行。

retention的职责与API不同：它必须跨workspace扫描数据库时间已到期的数据，以`FOR UPDATE SKIP LOCKED`并发领取，生成content-free tombstone，收敛正在执行的Memory extraction effect，再删除source、candidate或active Memory。它不需要读取Job、Article、Eval正文，不运行模型，不执行migration，也不拥有schema。

## 决定

1. Memory retention使用独立login role和独立`DATABASE_MEMORY_RETENTION_URL`；进程还必须显式配置`MEMORY_RETENTION_DATABASE_ROLE`。不得回退到通用`DATABASE_URL`，也不得复用API、Worker、Eval或migration连接。
2. 该角色是高信任、窄能力的跨workspace service role：属性固定为`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS NOREPLICATION`。`BYPASSRLS`只解决全局due扫描没有终端用户scope的问题，不能替代精确table权限。
3. table权限清单只覆盖当前清理调用链：
   - source signal、Memory和candidate：`SELECT/UPDATE/DELETE`；其中`UPDATE`也是`SELECT FOR UPDATE`所需权限；
   - extraction task/attempt/effect：`SELECT/UPDATE`，用于把in-flight provider effect收敛到`cancelled | uncertain`；
   - outbox：`SELECT/UPDATE`，用于终止尚未发布的source pointer；
   - source/Memory tombstone：`SELECT/INSERT`；`SELECT`由真实PostgreSQL证明是`ON CONFLICT DO NOTHING`冲突探测所需；
   - 不授予任何sequence、Job、Article、Eval、workspace、principal、schema CREATE、TRUNCATE、REFERENCES或TRIGGER权限。
4. `packages/db/src/postgres-role-contract.ts`成为角色契约共享引擎；API与retention各自保留独立manifest。共享的是枚举、provisioning和verifier机制，不合并两种运行时权限。
5. provisioning先撤销角色在`public` schema、所有table和sequence上的现有权限，再按manifest重授；继续维持数据库级`REVOKE CREATE ON SCHEMA public FROM PUBLIC`。角色创建、密码生成和轮换仍属于云control plane/secret manager，不由CLI输出。
6. retention进程在readiness前必须从自身连接校验current user、精确有效权限全集、预期`BYPASSRLS`、无role membership、无数据库/对象ownership、schema USAGE与无CREATE。仅在部署步骤单独执行CLI verify不够，错误连接必须让每个实例启动失败。
7. 一次性真实PostgreSQL canary必须创建两个workspace，覆盖running reserved effect的source expiry、普通跨workspace source expiry、active Memory expiry和candidate expiry，并证明角色不能读取`jobs`。

## 结果与限制

retention不再依赖owner连接，权限漂移会在实例ready前fail closed。`BYPASSRLS`仍意味着凭据泄露时可跨workspace访问清单内表，因此该凭据必须与API/Worker隔离、单独轮换，并且不得被交互式分析或普通应用复用。精确权限只限制SQL能力，不替代备份、审计、连接来源限制和secret管理。

本决策不定义write Worker、outbox dispatcher、Eval consumer/sampler或migration角色；这些运行时仍需按各自调用链拆分，不能复制retention manifest。真实云数据库的TLS、连接池、credential rotation和网络策略仍需目标环境部署证据。

## 回滚

可停止retention实例并撤销该角色login，但已按retention承诺删除的内容不可恢复。应用回滚不得把`DATABASE_MEMORY_RETENTION_URL`替换为owner URL；若旧artifact只支持`DATABASE_URL`，应保持停机并由受控maintenance任务接管，直到部署支持独立角色的版本。权限回滚使用对应版本provisioner重新收敛，不重新授予`PUBLIC` schema CREATE。
