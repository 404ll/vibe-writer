# Durable TypeScript 路径切流与回滚 Runbook

> 当前结论：仅可用于受限 staging。principal/workspace、scoped repository 与 RLS 已落地；公开生产切流在真实 auth/proxy 与专用 DB role、历史 SQLite 数据策略和 live/shadow eval 完成前仍为 **No-Go**。

## 0. 本地产品验证（非公开生产）

Iteration 0061已经把durable路径组合为可直接使用的本地MVP。准备包含`ANTHROPIC_API_KEY`和`MODEL_ID`的根目录`.env`，从仓库根目录运行：

```bash
pnpm dev:durable
```

该命令会启动只监听loopback端口的持久化PostgreSQL/Redis，执行Drizzle migration、LangGraph checkpoint setup以及API/dispatcher/consumer角色provision和self-verify，再启动Next与TypeScript Worker。浏览器访问`http://127.0.0.1:3000`，Worker readiness位于`http://127.0.0.1:3001/ready`。隔离worktree可以用`DURABLE_DEV_ENV_FILE=/absolute/path/to/.env`指定配置文件。

完整无付费模型smoke与停止命令：

```bash
pnpm test:durable-product:local
pnpm dev:durable:down
```

本地composition的边界：

- `DURABLE_AUTH_MODE=local-development`仅在`NODE_ENV=development`接受显式固定UUID，production会fail closed；
- Compose中的固定凭据仅用于loopback开发容器，不能部署到共享环境；
- 命名volume默认保留Job、事件、checkpoint、Article和版本，`dev:durable:down`不删除volume；
- Memory provider consumer、RAG和付费Eval未随主链路启用；
- 旧SQLite文章不会自动导入，FastAPI/Python仍可作为兼容回滚路径。

本节只回答“本地切流后是否可用”。以下章节仍是公开staging/production部署协议，门禁没有因本地模式而放宽。

## 1. 配置面

| 组件 | 配置 | 迁移默认 | durable切流值 | 生效时机 |
|---|---|---:|---:|---|
| Browser client | `NEXT_PUBLIC_API_BASE` | `/api` | `/api/durable` | `next build` |
| Next durable routes | `DURABLE_API_ENABLED` | `false` | `true` | runtime |
| Article Server Component | `DURABLE_ARTICLE_READ_ENABLED` | `false` | `true` | runtime |
| Memory signal staging | `DURABLE_MEMORY_SIGNAL_API_ENABLED` | `false` | 仅独立canary时`true` | runtime |
| Memory management staging | `DURABLE_MEMORY_MANAGEMENT_API_ENABLED` | `false` | 仅独立canary时`true` | runtime |
| Memory consent policy | `MEMORY_CONSENT_POLICY_VERSION` | 未配置 | 精确命中append-only registry中的UI文档version | runtime |
| Durable auth adapter | `DURABLE_AUTH_MODE` | disabled | `trusted-proxy` 或未来 session adapter | runtime |
| API database role | `DATABASE_API_URL` | fallback `DATABASE_URL` | 非owner、无`BYPASSRLS` | runtime |
| Python rewrite/reference | `API_PROXY_TARGET` | FastAPI origin | 保留到回滚窗结束 | `next build`/server |
| Worker | `DURABLE_WORKER_ENABLED` | `false` | `true` | runtime |
| Worker role | `DURABLE_WORKER_ROLE` | `all` | 部署拓扑决定 | runtime |
| Dispatcher DB | `DATABASE_WRITE_DISPATCHER_URL` + `WRITE_DISPATCHER_DATABASE_ROLE` | 无 | 独立non-owner role | runtime |
| Consumer DB | `DATABASE_WRITE_CONSUMER_URL` + `WRITE_CONSUMER_DATABASE_ROLE` | 无 | 独立`BYPASSRLS` service role | runtime |
| Checkpoint setup | `DATABASE_CHECKPOINT_ADMIN_URL` | 无 | 仅部署命令可见 | deploy/migration |
| Worker probe | `WORKER_HEALTH_PORT` | 未监听 | 显式端口 | runtime |

前三个Web配置必须作为同一发布单元。只切浏览器会让文章首屏继续查SQLite；只切Server Component会让旧Python article id查PostgreSQL。

## 2. No-Go 条件

任一条件成立时不得切公开流量：

- 真实 auth adapter 未部署，trusted proxy 未证明会 strip 客户端 header 并注入已验证的 internal principal/workspace；
- Next API 仍使用数据库 owner/service连接，或API role具备 `BYPASSRLS`；
- API role verifier报告任何缺失/额外table或sequence权限、上游role membership、对象ownership、schema CREATE，或`public`仍向`PUBLIC`授予CREATE；
- dispatcher/consumer复用相同URL或role、任一runtime使用owner/migration连接、current-role verifier失败，或consumer启动仍执行checkpoint setup；
- 历史SQLite article/version没有完成可回滚迁移，且产品仍要求访问历史文章；
- API `/ready` 或任一consumer/dispatcher `/ready` 非200；
- migration、备份恢复演练、真实provider smoke或shadow quality eval没有证据；
- 存在未解释的 `run_effects.status = 'uncertain'`；
- staging canary无法完成 create → SSE/replay → article detail；
- Memory signal canary启用时，policy version与UI文本不一致、API role/RLS未验证或删除传播未通过；
- Memory management canary启用时，policy registry/readiness、viewer/editor/owner矩阵、review conflict replay或owner erasure未验证；
- rollback负责人、窗口和数据对账方法未明确。

## 3. Durable API role

API role覆盖同一`DATABASE_API_URL`上的Job、Article与Memory HTTP Route Handler，不覆盖Worker、migration、dispatcher、retention、Eval或运维查询。精确清单位于`packages/db/src/durable-api-role.ts`，部署脚本和verifier必须从该清单生成，不能复制一份手写GRANT长期漂移。

先通过云数据库控制面或secret manager创建带随机密码的login role。密码不得进入仓库、命令历史、CI日志或canary输出。下面的provision命令假设角色已经存在：

```bash
DATABASE_ADMIN_URL=postgresql://migration-role:secret@postgres/vibe_writer \
DURABLE_API_ROLE=vibe_writer_api \
pnpm --filter @vibe-writer/db durable-api-role:provision
```

该步骤会：

- 把角色固定为`NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`；
- 执行数据库范围的`REVOKE CREATE ON SCHEMA public FROM PUBLIC`；
- 撤销该角色对当前`public` schema、全部table和sequence的直接权限；
- 只重授当前Durable HTTP路径所需权限。

撤销`PUBLIC` CREATE可能影响依赖默认schema写入的其他应用。先审计依赖，再把CREATE显式授给具体migration/service角色；不得为了兼容恢复给`PUBLIC`。provision不创建密码，不负责Worker或maintenance角色。

随后必须用**API连接自身**运行verifier：

```bash
DATABASE_API_URL=postgresql://vibe_writer_api:secret@postgres/vibe_writer \
DURABLE_API_ROLE=vibe_writer_api \
pnpm --filter @vibe-writer/db durable-api-role:verify
```

只有返回`status=verified`才能启动candidate。verifier比较所有`public`表与sequence的有效权限全集，并检查角色属性、membership、ownership与schema权限；admin连接上的grant查询不能替代该命令。每次migration新增表、sequence或改变Route Handler访问面后都要重跑provision + verify + canary。

## 4. Write runtime roles

checkpoint schema必须先由受控管理身份初始化，长期运行consumer不得持有或读取该URL：

```bash
DATABASE_CHECKPOINT_ADMIN_URL=postgresql://migration-role:secret@postgres/vibe_writer \
pnpm setup:checkpoint-schema
```

通过云控制面或secret manager创建两个带独立随机密码的login role后，按versioned manifest收敛权限：

```bash
DATABASE_ADMIN_URL=postgresql://migration-role:secret@postgres/vibe_writer \
WRITE_DISPATCHER_DATABASE_ROLE=vibe_writer_write_dispatcher \
pnpm --filter @vibe-writer/db write-dispatcher-role:provision

DATABASE_ADMIN_URL=postgresql://migration-role:secret@postgres/vibe_writer \
WRITE_CONSUMER_DATABASE_ROLE=vibe_writer_write_consumer \
pnpm --filter @vibe-writer/db write-consumer-role:provision
```

随后必须分别从runtime连接自身verify：

```bash
DATABASE_WRITE_DISPATCHER_URL=postgresql://vibe_writer_write_dispatcher:secret@postgres/vibe_writer \
WRITE_DISPATCHER_DATABASE_ROLE=vibe_writer_write_dispatcher \
pnpm --filter @vibe-writer/db write-dispatcher-role:verify

DATABASE_WRITE_CONSUMER_URL=postgresql://vibe_writer_write_consumer:secret@postgres/vibe_writer \
WRITE_CONSUMER_DATABASE_ROLE=vibe_writer_write_consumer \
pnpm --filter @vibe-writer/db write-consumer-role:verify
```

dispatcher只有outbox领取/结算权限。consumer为跨workspace队列处理显式使用`BYPASSRLS`，但仅有durable execution和`langgraph_checkpoint` DML；没有schema CREATE、checkpoint migration ledger、DELETE或职责外数据读取权限。`role=all`仍要求两套不同URL与role。任何migration或saver升级改变SQL访问面后，先更新manifest和真实canary，再重新provision/verify。

## 5. Staging 预检

1. 固定本次 `code_revision`、graph/prompt/tool/model profile，并备份PostgreSQL与旧SQLite。
2. 对目标PostgreSQL运行受控Drizzle migration，再执行checkpoint setup、两个write role provision与self-verify；Worker运行时不执行DDL。
3. 启动Redis、dispatcher和consumer。每个Worker配置唯一 `WORKER_ID`，consumer配置provider secret，两个runtime使用各自专用数据库URL，健康端口只暴露探针。
4. 确认：

```bash
curl -fsS http://worker-host:3001/live
curl -fsS http://worker-host:3001/ready
curl -fsS https://staging.example/api/durable/health/live
curl -fsS https://staging.example/api/durable/health/ready
```

5. 保持用户浏览器仍走 `/api`，通过真实身份入口向 `/api/durable/jobs` 发带 `Idempotency-Key` 的canary；验证代理不会透传伪造的 `x-vibe-principal-id/x-vibe-workspace-id`，再验证SSE重连、终态、article、run版本和effect状态。
6. 按[Legacy SQLite迁移Runbook](./legacy-sqlite-article-migration.md)执行实际source dry-run/apply/replay，并核对数量、内容hash、版本顺序与抽样渲染。

Memory signal只作为独立canary开启，不跟随浏览器API切流自动启用：

```text
DURABLE_MEMORY_SIGNAL_API_ENABLED=true
MEMORY_CONSENT_POLICY_VERSION=memory-consent-v1
```

由真实身份入口提交带`Idempotency-Key`、`explicit_user`和精确policy version的personal signal；验证首次201、exact replay 200、payload drift 409、viewer shared subject 403、list不含fingerprint，并在删除后确认正文与派生Memory清除而tombstone不含正文。创建会留下`memory.extraction.requested` outbox；在shadow consumer单独获批前不得把该outbox已存在解释成模型处理已启用。

management canary独立设置`DURABLE_MEMORY_MANAGEMENT_API_ENABLED=true`。先访问`/api/durable/memory/policy`和`/memory`，确认展示version精确命中registry且导航只在feature启用时出现；再依次验证viewer可读active/own signal但不显示candidate或删除、editor可读candidate/event并能reject/materialize、conflict缺少current Memory id返回409、owner删除返回不含正文/fingerprint的receipt。用超过一页的隔离fixture验证active/signal/candidate cursor无重复且不跨workspace/author。复查所有GET为`no-store`，candidate DTO不得出现source UUID/evidence fingerprint/review actor。不要为测试删除传播而使用生产用户数据。

## 6. 切流步骤

1. 构建候选Web artifact：

```bash
NEXT_PUBLIC_API_BASE=/api/durable pnpm build:web
```

2. 候选runtime同时设置：

```text
DURABLE_API_ENABLED=true
DURABLE_ARTICLE_READ_ENABLED=true
DURABLE_AUTH_MODE=trusted-proxy
DATABASE_API_URL=postgresql://vibe_writer_api:secret@postgres/vibe_writer
```

3. 先发布不接用户流量的candidate实例；确认API和Worker readiness均为200。
4. 在candidate创建一条canary job，直到收到terminal SSE；打开返回的article页面并完成一次revision-safe编辑/restore。
5. 小比例接流量，观察queued/running/awaiting_input时长、error/cancel比例、outbox backlog、lease takeover、uncertain effects、provider错误和SSE重连。
6. 扩大流量前重新核对历史文章抽样；不要因为HTTP 200跳过内容一致性检查。

## 7. 回滚

1. 先停止新的durable job流量，不要立即关闭Worker。
2. 等待已创建的queued/running job完成或显式cancel；记录仍在awaiting_input或uncertain的job。
3. 发布旧Web artifact，使浏览器回到 `/api`，并设置 `DURABLE_ARTICLE_READ_ENABLED=false`。`API_PROXY_TARGET` 在整个回滚窗保持可用。
4. 保留PostgreSQL和Redis证据，不删除新路径数据。对切流窗口内新生成/编辑的article做正向迁移或人工对账后，才能宣布回滚完成。
5. Worker无新任务且所有实例readiness已退出后，再停止consumer/dispatcher。

回滚Web并不会自动把PostgreSQL新文章复制回SQLite；忽略这一步会造成用户数据“看似消失”。

## 8. 只读诊断

```sql
select status, count(*) from jobs group by status order by status;
select status, count(*) from outbox_events group by status order by status;
select status, count(*) from run_effects group by status order by status;
select count(*) from articles;
```

诊断查询必须由受控service/ops角色执行，不能复用API连接。公开API使用非owner、无`BYPASSRLS`角色，并在每个事务设置`app.principal_id/app.workspace_id`；scoped repository predicate与RLS必须同时保留。

## 9. 当前可重复门禁

```bash
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
pnpm test:db:postgres:local
pnpm test:worker:redis:local
pnpm test:worker:production:local
pnpm test:memory-api-canary:local
```

`test:worker:production:local`会以一次性真实PostgreSQL+Redis启动production Worker：owner只执行migration、checkpoint setup、role provision和seed；runtime用两个non-owner连接验证readiness、completed与outline resume、运行中provider cancellation、provider 5xx、expired-lease takeover，并证明dispatcher不能读Job、consumer不能读outbox/运行setup、两者不能创建schema。随后以durable配置构建并启动Next.js验证Server Component文章读取。provider仍为本地协议fixture，不等于live质量评测。

`test:memory-api-canary:local`不启动Redis或provider；它以一次性真实PostgreSQL配置精确API role，运行current-connection verifier，构建并启动真实Next，再通过loopback header-stripping proxy验证伪造header、401/403、viewer/editor/owner、跨workspace RLS、动态candidate review、owner erasure与signal撤回。该proxy是协议夹具，不是目标Ingress/Auth已经部署的证据；staging仍须复跑同类攻击并证明Next没有公网旁路。
