# ADR-0026：供应商无关的 Workspace Identity 与双层隔离

- 状态：Accepted
- 日期：2026-08-07

## 背景

Durable API 已具备 job、SSE、reply、cancel 和 article 读写，但此前所有查询只使用裸 `job_id/article_id`，`jobs.idempotency_key` 也是全局唯一。Eval 的 `namespace_key` 只是可检索标签，不代表登录身份、成员关系或数据库安全边界。继续在这个模型上实现 Memory，会让长期用户信息、评测样本和写作内容共享一个不可验证的全局空间。

当前尚未决定使用 Auth.js、Clerk、自建 OIDC 或企业 SSO。现在把某一认证 SDK 的 session 类型写入领域层，会让未来更换供应商时同时重写 Job、Memory 和 Eval 的归属模型。

## 决定

1. 领域身份采用 `principals → principal_identities` 两层：principal 是内部稳定主体，identity 以 `issuer + subject` 映射外部认证身份，允许未来绑定多个 provider。
2. 协作边界采用 `workspaces → workspace_memberships`；membership 角色为 `owner | editor | viewer`。Job 必须保存 `workspace_id + created_by_principal_id`，子表通过 Job 继承归属。
3. Job 幂等语义改为 `(workspace_id, idempotency_key)`，同一个浏览器请求键可在不同 workspace 独立使用。
4. API 只能从 `AuthorizedWorkspaceScope` 创建 scoped repositories。读查询显式带 workspace 过滤；create、reply、cancel、article patch/restore 在 repository 边界拒绝 viewer。
5. PostgreSQL 对 principal/workspace、Job 子图、Article 子图和 workspace Eval suite 启用 RLS。API 请求在事务内设置 `app.principal_id` 与 `app.workspace_id`；Worker、migration 和 outbox 使用受控 service role，不复用公开 API role。
6. Next.js 提供供应商无关的 `trusted-proxy` 适配缝：只有显式配置 `DURABLE_AUTH_MODE=trusted-proxy` 才接受内部 UUID header。反向代理必须删除客户端传入的同名 header，再注入已验证的 principal/workspace；未配置、缺 header 或无 membership 时 fail closed。
7. 迁移创建保留的 legacy system principal/workspace，先回填已有 Job，再将归属列收紧为 `NOT NULL`。该 scope 只用于历史导入、系统 fixture 和受控 migration，不作为产品请求默认值。
8. `eval_suites.workspace_id` 允许为空：synthetic/system regression suite 可保持系统级；任何用户内容 Eval 必须在后续 ingest policy 中绑定 workspace。未来 thread、memory、source 和 embedding 表必须直接携带 workspace 归属，不能只复用 opaque namespace 字符串。

## 隔离层次

```text
verified external identity
  → internal principal
  → active workspace membership + role
  → AuthorizedWorkspaceScope
  → explicit repository predicate
  → transaction-local PostgreSQL RLS
```

repository predicate 是应用层最小权限和测试接口；RLS 是数据库防御层。两者不能互相替代。数据库 owner 会绕过普通 RLS，因此公开 API 必须使用非 owner、无 `BYPASSRLS` 的专用连接角色。

## 安全不变量

- 未验证的 header 不能直接构造 `AuthorizedWorkspaceScope`。
- workspace 归属在 Job 创建后不可修改；子实体不能脱离 Job 单独换租户。
- viewer 可读但不能创建任务、回复、取消或修改文章。
- RLS session setting 必须是 transaction-local，连接回池前不得残留 scope。
- direct-to-Next 流量不得与 `trusted-proxy` 模式同时公开；代理 header strip/inject 是上线门槛。
- 系统 Eval 与用户内容 Eval 的数据分类、保留和权限策略必须分开。

## 未选择

- 立即绑定某一认证 SaaS：现在需要的是稳定内部模型和适配接口，而不是提前锁定供应商。
- 只在 API route 里检查 header：无法保护 Server Component、repository 复用和误写 SQL。
- 只依赖 RLS：owner/service connection 会绕过，且业务角色权限仍需应用层表达。
- 把 `namespace_key` 当 tenant id：它没有 membership、状态、外部身份映射或数据库约束。
- 给 `jobs.workspace_id` 永久默认 system workspace：会让漏传身份的生产请求静默落入共享租户。

## 影响与后续

公开切流仍是 No-Go，直到部署侧证明 trusted proxy header 清洗、专用非 owner API role、secret/connection 分离和真实登录流程。下一迭代需要把该边界加入 production composition 的跨 workspace HTTP 负例，并决定首个认证 adapter。Memory 实现应从 workspace-scoped thread/subject 和治理策略开始，而不是先建全局向量表。
