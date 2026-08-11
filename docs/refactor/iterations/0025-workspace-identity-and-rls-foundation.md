# Iteration 0025：Workspace Identity 与 RLS 基础

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0026](../decisions/0026-provider-neutral-workspace-identity-and-rls.md)
- 评测记录：[Eval 0021](../evals/0021-workspace-isolation-baseline.md)

## 目标

在不绑定认证供应商的前提下，把 principal、workspace、membership、角色、Job 归属和 PostgreSQL RLS 变成真实工程边界，为公开 API、Memory 和用户内容 Eval 提供同一套可扩展 namespace。

## 范围内

- principal、external identity、workspace、membership schema；
- Job workspace/creator 强归属和 workspace-scoped 幂等键；
- legacy system scope 的安全回填 migration；
- workspace-scoped Job/command/article repositories 与 viewer 写保护；
- transaction-local RLS session 和非 owner API role 真实 PostgreSQL验证；
- Next durable Route/Server Component 的 fail-closed trusted-proxy identity seam；
- `eval_suites.workspace_id` 可选归属；
- production composition harness 的身份 header；
- 系统设计、ADR、切流 Runbook 和 Eval 证据。

## 范围外

- 不选择或部署 Auth.js、Clerk、OIDC/SSO provider；
- 不实现登录 UI、邀请、workspace 切换或成员管理 API；
- 不把 trusted header 当成可直接公开的完整认证方案；
- 不实现 Memory 表、提取、retrieval 或删除治理；
- 不迁移现网 source，不切公开流量；
- 不把 system synthetic Eval 强行归属某个用户 workspace。

## 关键行为

1. 旧 Job 在 migration 中归入显式 legacy system scope；新 Job 漏传 scope 在类型和数据库层失败。
2. 两个 workspace 可以复用同一 idempotency key，生成不同 Job。
3. scoped repository 对跨 workspace Job/Article 返回空或 `not_found`，不会暴露资源存在性。
4. viewer 只能读取，写作任务和文章 mutation 在 repository/HTTP 两层拒绝。
5. RLS 未设置事务 scope 时，非 owner API role 看不到 Job；设置 workspace A 后仍看不到 workspace B。
6. Next durable API 在 auth mode 未配置、header 缺失或 membership 无效时 fail closed。

## 验证

- `pnpm test:db`：10 个文件、61 项通过；migration回填、scoped repository、viewer写保护通过；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 10 项、Checkpoint 4 项通过；非 owner RLS 负例/正例通过；Eval register 重放通过；临时实例已停止；
- `pnpm test:web`：12 个文件、31 项通过；auth未配置、缺身份、viewer写入与durable route行为通过；
- `pnpm test:worker:production:local`：真实PostgreSQL + Redis/BullMQ + Worker composition Eval、legacy SQLite dry-run/apply/replay、带system identity的Next durable API/SSR通过；临时服务已停止；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 345项、Python 50项，共395项测试通过；lint/build、全部typecheck、migration check、component gate与workflow shadow gate通过；
- `pnpm check:docs`：84个Markdown文件链接通过；
- `git diff --check`：通过。

## 退出条件

1. identity/workspace migration 可升级已有 Job：已满足。
2. 应用 scoped repository 隔离 Job、Article、mutation 和幂等语义：已满足。
3. 非 owner PostgreSQL role 的 RLS 有真实双 workspace 证据：已满足。
4. Next durable 路径无身份时 fail closed：已满足。
5. production composition 与根级 verify 通过：已满足。
6. 首个真实 auth provider 已接入：不属于本迭代，公开切流仍 No-Go。

## 回滚

先把浏览器保持或切回 Python `/api`，关闭 `DURABLE_API_ENABLED` 和 `DURABLE_ARTICLE_READ_ENABLED`。不要删除 identity/workspace 表或已回填列；旧 runtime 不读取这些列。数据库 down migration 会丢失归属与 membership，不作为正常回滚手段。

## 后续

1. 选定并实现首个认证 adapter，部署 trusted proxy strip/inject 或直接 session adapter；
2. 部署专用非 owner `DATABASE_API_URL`，Worker/migration 使用独立 service URL；
3. production projection 增加跨 workspace HTTP 泄漏、reply/cancel/failure/takeover；
4. Eval ingest 对 `user_content` 强制 workspace 与 retention policy；
5. 以 workspace/thread/subject 为根开始 Memory schema 与专项 eval。
