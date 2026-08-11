# ADR-0059：Write Runtime 独立数据库角色与 Checkpoint DDL 分离

- 状态：Accepted
- 日期：2026-08-10

## 背景

当前production Worker支持`all | dispatcher | consumer`三种进程角色，但三者都读取同一个`DATABASE_URL`并共享一条数据库身份。更严重的是，consumer在每次启动时调用LangGraph PostgreSQL saver的`setup()`；该操作会创建schema/table并写migration ledger，因此长期运行的模型执行进程必须持有DDL能力。这样既无法独立轮换dispatcher与consumer凭据，也会把队列发布缺陷、provider/tool执行缺陷和checkpoint schema管理放进同一个数据库爆炸半径。

dispatcher与consumer的真实调用链不同：dispatcher只领取和更新`outbox_events`；consumer跨workspace领取Job，维护lease、run/effect/trace/checkpoint attempt，写terminal Article和Memory extraction outbox，并在独立`langgraph_checkpoint` schema读写checkpoint payload。二者都不应拥有数据库、schema或对象，也不应执行migration。

## 决定

1. write dispatcher使用独立login role、`DATABASE_WRITE_DISPATCHER_URL`与`WRITE_DISPATCHER_DATABASE_ROLE`。其权限仅为`public.outbox_events`的`SELECT/UPDATE`，属性固定为`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`。
2. write consumer使用另一个login role、`DATABASE_WRITE_CONSUMER_URL`与`WRITE_CONSUMER_DATABASE_ROLE`。consumer没有终端用户workspace session且必须跨workspace领取队列Job，因此显式使用`BYPASSRLS`；该属性只绕过row policy，不扩大table/schema权限。
3. consumer的public table权限按production调用链固定为：
   - `jobs`：`SELECT/UPDATE`；
   - `runs`、`run_effects`、`trace_spans`、`checkpoint_attempts`：`SELECT/INSERT/UPDATE`；
   - `job_events`：`SELECT/INSERT`；
   - `job_interrupts`、`articles`：`SELECT/INSERT`；
   - `job_commands`：`SELECT`；
   - `outbox_events`：`INSERT`；
   - 不授予`article_versions`、Memory正文、Eval、identity表、DELETE、TRUNCATE、REFERENCES、TRIGGER或sequence权限。
4. consumer在`langgraph_checkpoint` schema只获得`USAGE`和当前fenced saver所需DML：`checkpoints`为`SELECT/INSERT/UPDATE`，`checkpoint_blobs`为`SELECT/INSERT`，`checkpoint_writes`为`SELECT/INSERT/UPDATE`。运行时不访问`checkpoint_migrations`，也不获得schema `CREATE`或checkpoint `DELETE`。
5. checkpoint schema setup从consumer启动路径移出，由显式管理命令使用`DATABASE_CHECKPOINT_ADMIN_URL`先行执行。部署顺序固定为migration/checkpoint setup、角色provision、角色verify、runtime rollout。长期运行consumer不得调用`saver.setup()`。
6. `all`模式只表示同一进程承载两个loop，不表示身份合并；它必须同时提供两套URL/role，并建立两个数据库连接。两套role name或URL相同应在配置阶段失败。
7. PostgreSQL role contract引擎扩展为schema-aware精确验证：对manifest管理的每个schema撤销后重授，枚举当前连接的有效table/sequence/schema权限，并验证无membership、数据库/受管对象ownership及额外权限。
8. dispatcher和consumer都必须在readiness前用自身连接完成current-role与schema完整性校验；仅在部署流水线运行一次CLI verify不足以证明实例没有拿错secret。
9. 一次性真实PostgreSQL/Redis canary必须让owner只负责migration、checkpoint setup、role creation和seed；完整production projection通过两个非owner连接运行，并证明dispatcher不能读取Job、consumer不能读取outbox、两者都不能创建schema。

## 结果与限制

队列发布、模型执行和schema管理的凭据可以独立轮换与撤销；consumer泄露仍因`BYPASSRLS`可以跨workspace访问清单内表，所以该角色属于高信任、窄能力服务身份，必须限制网络来源并单独监控。`all`模式方便单机和小规模部署，但生产可继续拆成独立dispatcher/consumer进程而无需改变数据库契约。

本决策不定义Eval dispatcher/consumer/sampler、Memory extraction/retention以外的后台角色，也不选择云数据库、连接池、secret manager或credential rotation产品。未来若LangGraph saver升级后新增SQL操作，必须先更新versioned manifest和真实canary，不能直接扩大为全schema权限。

## 回滚

可以停止新runtime并恢复旧artifact，但不得把专用URL替换成owner/migration URL来规避启动校验。若旧artifact仍在启动时执行checkpoint setup，应保持consumer停机，先由管理命令确认schema，再以临时、审计过的兼容角色运行；完成回滚后立即撤销多余DDL权限。role权限回滚使用对应版本provisioner重新收敛，不恢复`PUBLIC` schema CREATE。
