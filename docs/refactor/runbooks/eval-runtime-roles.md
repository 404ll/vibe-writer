# Eval Runtime 数据库角色 Runbook

适用于Eval queue dispatcher、consumer与live sampler的首次部署、权限变更、凭据轮换和回滚。角色契约以`packages/db/src/eval-runtime-roles.ts`为唯一来源；不要长期维护另一份手写GRANT清单。

## 角色边界

| Runtime | 连接配置 | 关键权限 | 明确禁止 |
|---|---|---|---|
| dispatcher | `DATABASE_EVAL_DISPATCHER_URL`、`EVAL_DISPATCHER_DATABASE_ROLE` | `outbox_events SELECT/UPDATE` | Eval run/case/report、Job、Article、DDL |
| consumer | `DATABASE_EVAL_CONSUMER_URL`、`EVAL_CONSUMER_DATABASE_ROLE` | Eval run领取、suite/case/candidate读取、trial/score写入、校准授权读取 | outbox、Job、Article、sampling policy、DELETE、DDL |
| live sampler | `DATABASE_EVAL_LIVE_SAMPLER_URL`、`EVAL_LIVE_SAMPLER_DATABASE_ROLE` | policy/candidate DML与Job/Run/Article安全列读取 | topic、正文、execution snapshot、Eval case、DDL |

dispatcher为`NOBYPASSRLS`；consumer和sampler因跨workspace系统职责显式使用`BYPASSRLS`。后两者仍不是owner、superuser、migration或运维查询角色。

## 部署顺序

1. 先用migration/admin身份完成Drizzle migration。三个runtime角色不能执行migration。
2. 在secret manager或control plane创建三个不同的login role和密码；限制网络来源与连接数，不把密码写入仓库或命令输出。
3. 从admin连接分别收敛权限：

```bash
DATABASE_ADMIN_URL=postgresql://... \
EVAL_DISPATCHER_DATABASE_ROLE=eval_dispatcher \
pnpm --filter @vibe-writer/db eval-dispatcher-role:provision

DATABASE_ADMIN_URL=postgresql://... \
EVAL_CONSUMER_DATABASE_ROLE=eval_consumer \
pnpm --filter @vibe-writer/db eval-consumer-role:provision

DATABASE_ADMIN_URL=postgresql://... \
EVAL_LIVE_SAMPLER_DATABASE_ROLE=eval_live_sampler \
pnpm --filter @vibe-writer/db eval-live-sampler-role:provision
```

4. 从每个runtime自身连接验证current user与精确有效权限：

```bash
DATABASE_EVAL_DISPATCHER_URL=postgresql://eval_dispatcher@... \
EVAL_DISPATCHER_DATABASE_ROLE=eval_dispatcher \
pnpm --filter @vibe-writer/db eval-dispatcher-role:verify

DATABASE_EVAL_CONSUMER_URL=postgresql://eval_consumer@... \
EVAL_CONSUMER_DATABASE_ROLE=eval_consumer \
pnpm --filter @vibe-writer/db eval-consumer-role:verify

DATABASE_EVAL_LIVE_SAMPLER_URL=postgresql://eval_live_sampler@... \
EVAL_LIVE_SAMPLER_DATABASE_ROLE=eval_live_sampler \
pnpm --filter @vibe-writer/db eval-live-sampler-role:verify
```

5. 先启动dispatcher并观察pointer发布，再启动consumer，最后启动sampler。`EVAL_QUEUE_ROLE=all`仍必须提供dispatcher和consumer两套不同URL/role。

## 上线门禁

- 三个verify均返回`status=verified`且没有额外table/column/sequence/schema权限；
- runtime启动日志没有role/schema verifier错误；
- queue可完成synthetic canary，Redis payload只有schema version与Eval run UUID；
- sampler推进cursor并创建content-free candidate；
- 负例确认dispatcher不能读`eval_runs`、consumer不能读`outbox_events`、sampler不能读`articles.content`，三者不能`CREATE SCHEMA`；
- pool上限、连接来源、TLS、密码轮换和告警在目标环境有证据。

本地联合门禁为`pnpm test:eval-queue:local`，sampler列级ACL门禁包含在`pnpm test:db:postgres:local`。它们使用一次性loopback PostgreSQL/Redis，不能替代目标环境网络和secret验证。

## 变更与轮换

schema或repository查询改变时，先更新manifest、ADR/iteration和真实canary，再执行migration与provision。新增列不会自动进入sampler读取范围；这是预期的fail-closed行为。凭据轮换时先创建/收敛新role并verify，再滚动切换实例，确认旧实例排空后撤销旧role login。

## 回滚

1. 停止失败runtime，保留PostgreSQL run/candidate/report与Redis诊断证据；
2. 不得临时注入owner或通用`EVAL_DATABASE_URL`绕过startup verifier；
3. 若新权限清单错误，修正manifest并重新provision/verify；
4. 若需回滚artifact，使用与旧artifact匹配且同样受控的独立角色，不合并三套身份；
5. 确认无旧实例后撤销故障role login。production数据不因runtime回滚而删除。
