# Eval 0021：Workspace Isolation 基线

- 日期：2026-08-07
- 结论：Passed for repository and real PostgreSQL RLS scope
- 对应迭代：[0025](../iterations/0025-workspace-identity-and-rls-foundation.md)

## Identity

| 项目 | 值 |
|---|---|
| dataset | synthetic workspace A/B identities and resources |
| target | Drizzle migration + scoped repositories + PostgreSQL RLS |
| metric | no cross-workspace visibility or mutation |
| database | PGlite fast migration; disposable local PostgreSQL multi-session |
| auth seam | internal UUID headers under explicit `trusted-proxy` mode |

## Gate

| 场景 | 预期 | 结果 |
|---|---|---|
| populated schema upgrade | old Job backfilled to explicit system scope | Passed |
| idempotency | same key in workspace A/B creates separate Job | Passed |
| scoped Job read/cancel/event | A cannot observe or mutate B | Passed |
| scoped Article list | A does not list B article | Passed |
| viewer role | read allowed, mutation rejected | Passed |
| missing membership | authorization returns null | Passed |
| API role without RLS scope | zero visible Job rows | Passed |
| API role with workspace A scope | only workspace A rows visible | Passed |
| durable HTTP missing identity | `401`, repository untouched | Passed |

## 命令证据

```text
pnpm test:db
pnpm typecheck:db
pnpm test:db:postgres:local
pnpm test:web
pnpm --filter @vibe-writer/web exec tsc --noEmit
pnpm check:migrations
git diff --check
```

真实 PostgreSQL harness 创建随机数据库与非 owner、无 `BYPASSRLS` 的临时 API role；scope 只使用 transaction-local `set_config`，结束后 PostgreSQL 已停止并清理。PGlite 负责 migration/backfill 和 scoped repository 快速回归，不替代 RLS 证据。

根级门禁另通过TypeScript 345项、Python 50项，共395项测试；38-case component gate、3-case workflow shadow gate、Web lint/build、migration check和84个Markdown链接检查均通过。联合production harness也通过真实PostgreSQL、Redis/BullMQ、Worker、legacy SQLite migration以及带身份header的durable API/SSR，并停止全部临时服务。

## 未证明

- 未接真实登录 provider、邀请/成员管理或 workspace switch UI；
- 未在真实反向代理验证 header strip/inject，direct-to-Next 仍不可公开；
- 未验证托管连接池 transaction mode 与 RLS session 配置；
- production composition 尚未包含 workspace A 请求 workspace B ID 的 HTTP 负例；
- `eval_suites.workspace_id` 已有 schema，但用户内容 ingest/retention policy 尚未实现；
- Memory 尚未实现，因此还没有跨 workspace memory leakage eval。

## 结论

workspace 已从文档概念变为 Job/Article 的应用查询边界和数据库防御边界。该结果为 Memory/Eval 提供稳定归属模型，但不是完整认证上线证据，公开切流仍需 provider/proxy、专用 DB role 和部署级负例。
