# ADR-0065：托管 PostgreSQL 使用 single-workspace Consumer

- 状态：Accepted
- 日期：2026-08-11
- 关联：[ADR-0059](./0059-write-runtime-database-roles.md)、[ADR-0064](./0064-retire-python-and-adopt-vercel-web.md)

## 背景

write consumer需要跨workspace领取Job，因此原自托管PostgreSQL设计把它定义为精确table grant加`BYPASSRLS`的service role。Neon不提供真正PostgreSQL superuser；SQL创建的普通role可以精确grant，但operator不能给它设置`BYPASSRLS`，也不能执行包含`NOSUPERUSER`、`NOREPLICATION`等受限属性的`ALTER ROLE`。改用Neon控制面创建的`neon_superuser`成员会获得远超consumer manifest的权限，并被现有verifier拒绝。

当前Vercel Preview是固定单用户、固定workspace的个人MVP，不需要跨workspace消费。

## 决定

1. 保留原`cross-workspace` consumer contract作为自托管PostgreSQL和未来多租户运行模式。
2. 新增`single-workspace` consumer contract：table/schema grant完全相同，但角色保持`NOBYPASSRLS`。
3. consumer PostgreSQL连接通过startup `options`固定`app.workspace_id`；Worker readiness同时校验当前session scope与operator配置UUID一致。
4. managed-service provisioning只执行平台允许的`LOGIN NOINHERIT`，但role verifier仍检查superuser、create role/database、inherit、replication、BYPASSRLS、membership、ownership和有效权限全集；不能以“平台不允许ALTER”跳过验证。
5. Vercel API继续使用独立`NOBYPASSRLS`角色和transaction-local principal/workspace，不使用single-workspace consumer连接。

## 取舍

- 避免把Neon owner或`neon_superuser`交给Worker，同时保持数据库RLS有效。
- single-workspace consumer不能处理其他workspace；这与个人Preview边界一致，但未来多用户上线必须换成允许精确`BYPASSRLS`的受控PostgreSQL，或重新设计安全的全局claim函数。
- workspace UUID同时存在于连接配置和Worker配置；readiness的双重校验用于阻止配置漂移。

## 回滚

停止Worker，恢复`WRITE_CONSUMER_ACCESS_MODE=cross-workspace`以及真正具备精确`BYPASSRLS`属性的consumer role连接，再运行role verifier和production composition。不得回退到owner连接。
