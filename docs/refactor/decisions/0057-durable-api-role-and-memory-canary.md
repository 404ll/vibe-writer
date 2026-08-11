# ADR-0057：Durable API 最小权限角色与 Trusted-proxy Memory Canary

- 状态：Accepted
- 日期：2026-08-10

## 背景

Next.js Durable API 已覆盖Job、Article与Memory，但runtime仍可从`DATABASE_API_URL`回退到数据库owner连接。已有repository/RLS测试证明非owner角色可以被隔离，却没有证明真实`next start`使用同一非owner连接完成HTTP事务，也没有固定整组Durable Route Handler所需的精确表权限。

`DATABASE_API_URL`属于整个Durable HTTP面，不是Memory专属连接。只授权Memory表会让同一Next.js进程中的Job/Article路由失效；反过来给所有表全CRUD又无法称为最小权限。`trusted-proxy`也只有header解析 seam，尚无可重复证据证明入口会删除客户端伪造header再注入可信身份。

联合canary还暴露两个部署级问题：PostgreSQL可通过`PUBLIC`间接授予`public` schema `CREATE`，角色级`REVOKE`无法覆盖该权限；array-form Next rewrite会在动态App Router路由之前把`/api/:path*`转发到legacy FastAPI，使固定Durable路由可用而`[candidateId]`等动态路由被错误代理。

## 决定

1. `packages/db/src/durable-api-role.ts`是Durable HTTP数据库权限的唯一机器可读清单。角色覆盖当前公开Job、Article和Memory Route Handler，不覆盖Worker、migration、outbox dispatcher、retention或Eval maintenance。
2. 角色必须是`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`，不得属于其他角色、拥有当前数据库或`public`对象，也不得获得schema `CREATE`、table `TRUNCATE/REFERENCES/TRIGGER`或清单外DML。
3. 数据库安全基线必须执行`REVOKE CREATE ON SCHEMA public FROM PUBLIC`。这是数据库范围变更，部署前需审计依赖默认schema CREATE的其他应用；PostgreSQL没有可以只对API角色覆盖`PUBLIC`授权的DENY语义。
4. provisioning先撤销该角色在当前`public`表、sequence和schema上的直接权限，再按清单重授。`article_versions_id_seq`只授予`SELECT/USAGE`。`memory_source_signals`删除事务因`SELECT FOR UPDATE`需要`UPDATE`，该权限属于经过真实事务证明的最小集合。
5. verifier必须从待部署的`DATABASE_API_URL`当前连接运行，比较所有`public`表与sequence的**有效权限全集**，同时检查角色属性、schema、membership和ownership；缺失与额外权限都失败。仅查询admin视角的grant清单不能替代当前连接验证。
6. 新增隔离canary：启动一次性真实PostgreSQL，受控migration后创建API角色并运行verifier，以`DATABASE_API_URL`且不设置owner fallback启动production build的`next start`，再经本地header-stripping proxy执行真实HTTP。
7. canary必须证明：无可信session时伪造`x-vibe-*`仍为401；principal/workspace不匹配为403；代理覆盖伪造header；viewer/editor/owner矩阵、跨workspace RLS、personal/shared signal、candidate materialize、owner erasure和source撤回均成立；响应不泄露fingerprint/source/review actor。
8. legacy `/api/*` rewrite改为`fallback`。App Router Route Handler，包括所有动态`/api/durable/*`，必须先于FastAPI兼容代理匹配；只有Next不存在的API路径才回退Python。

## 结果与限制

Durable API第一次拥有可执行、可验证、与真实Next.js事务一致的数据库角色契约。角色清单会随HTTP repository访问面变化而显式漂移；新增表或操作若没有更新清单和canary会fail closed，而不是依赖owner连接掩盖问题。

本地proxy是协议夹具，只证明“strip再inject”的入口不变量与应用行为，不证明某个托管平台、Ingress或真实认证供应商已经正确配置。公开切流仍必须在目标环境复跑同类伪造header负例，并验证Next不能绕过代理直接从公网访问。canary使用随机本地session映射，不是production auth adapter。

当前角色契约只属于Durable API。Memory retention、Worker、migration、dispatcher和运维诊断仍需独立角色，不能复用API连接。

## 回滚

应用回滚可关闭Memory feature并恢复旧artifact，但不得把Next改回owner连接作为回滚。权限清单回滚应重新运行旧版本provisioner与verifier；已撤销的`PUBLIC` schema CREATE不自动恢复。如确有已审计的legacy依赖，需要单独向具体migration/service角色授予CREATE，不能重新授权`PUBLIC`。
