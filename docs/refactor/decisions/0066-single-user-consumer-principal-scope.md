# ADR-0066：单用户 Consumer 同时固定工作区与主体

- 状态：Accepted
- 日期：2026-08-11
- 关联：[ADR-0026](./0026-provider-neutral-workspace-identity-and-rls.md)、[ADR-0065](./0065-managed-postgres-single-workspace-consumer.md)

## 背景

ADR-0065让托管PostgreSQL上的Consumer通过连接启动参数固定`app.workspace_id`，避免使用owner或`BYPASSRLS`。真实Preview验收发现，`jobs_workspace_policy`的`WITH CHECK`还要求`created_by_principal_id`等于`app.principal_id`。仅固定工作区可以读取Job，却无法把Job从`queued`更新为`running`。

## 决定

1. `single-workspace`模式同时要求`WORKER_SINGLE_USER_WORKSPACE_ID`与`WORKER_SINGLE_USER_PRINCIPAL_ID`。
2. Consumer连接的PostgreSQL `options`同时固定`app.workspace_id`与`app.principal_id`。
3. Worker readiness同时读取并比较两项会话设置；任意一项缺失或漂移都拒绝就绪。
4. Consumer继续使用`NOBYPASSRLS`和精确table/schema grant，不改用owner，不扩大数据库权限。

## 取舍

- 该模式准确匹配受保护的单用户、单工作区Preview，并让RLS继续作为数据库侧最后防线。
- Worker会话只能处理同一主体创建的Job；未来多用户或多工作区上线时，必须恢复受控`BYPASSRLS`服务角色，或设计独立的安全领取函数，不能扩展这套固定身份方案。

## 回滚

停止Worker，恢复具备精确权限清单的`cross-workspace` Consumer连接，并移除两个固定身份配置。不得回退到owner连接。
