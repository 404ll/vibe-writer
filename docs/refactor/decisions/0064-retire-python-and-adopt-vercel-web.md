# ADR-0064：退役 Python 兼容路径并采用 Vercel Web 边界

- 状态：Accepted
- 日期：2026-08-11
- Supersedes：ADR-0061、ADR-0062 中继续保留 FastAPI/Python 回滚运行时的结论

## 背景

TypeScript durable 产品路径已经覆盖创建任务、outline interrupt/reply、SSE、模型与搜索调用、文章写入、编辑和版本恢复，并通过共享契约、组件 Eval、真实 PostgreSQL/Redis composition 与产品 smoke 验证。继续保留 FastAPI、进程内 JobStore、SQLite、Next rewrite 和跨运行时 shadow runner，会让开发、部署和故障判断仍然存在两套事实来源。

用户明确选择不再保留兼容回滚路径，并希望把 Web/API 部署到个人 Vercel。Vercel 适合承载 Next.js 页面与 Route Handler，但 BullMQ Worker 是持续监听 Redis 的常驻进程，不能与 Web 一起缩进请求生命周期内。

## 决定

1. 删除 `apps/api`、FastAPI rewrite、Python测试入口和Python/TypeScript workflow shadow执行器；`/api/durable`成为浏览器唯一API。
2. Article wire contract收紧为TypeScript事实：revision、source revision、mutation precondition和mutation article都为必填。
3. 删除SQLite article导入CLI、repository和production integration中的legacy migration场景。历史ADR、iteration、fixture可保留为迁移证据，但不再形成可执行运行时。
4. Web/API部署边界为Vercel Next.js；Worker继续作为独立常驻Node进程部署在个人服务器或容器平台。两者共享外部PostgreSQL；Worker另连Redis/BullMQ。
5. 首次上线只做受Vercel Authentication保护的Preview。`protected-single-user`身份模式仅在`VERCEL=1`、`VERCEL_ENV=preview`且operator显式声明外部访问保护时接受固定principal/workspace；任何其他环境fail closed。
6. Vercel Function中的PostgreSQL客户端每实例最多建立1条连接，降低弹性实例放大连接数的风险；生产仍优先使用支持serverless pooling的连接端点。
7. 回滚变为同一TypeScript artifact版本回滚与PostgreSQL备份恢复，不再通过Python/SQLite双栈回滚。

## 取舍

- 单一运行路径显著降低心智负担、依赖和部署歧义；代价是失去Python runtime级回滚。
- Vercel负责Web/API可以减少服务器运维；代价是Worker、PostgreSQL和Redis仍需独立托管。
- 受保护Preview足够用于个人MVP验证；代价是`protected-single-user`不是真实多用户认证，不能直接开放Production。
- 删除SQLite导入能力消除长期迁移负担；代价是未另行备份的旧SQLite数据不会自动进入新系统。该决策基于当前不需要保留旧部署数据的产品选择。

## 回滚

若本次改动本身需要回退，回滚Git commit并恢复同版本PostgreSQL备份。不得重新引入FastAPI rewrite作为临时旁路。若未来需要导入历史数据，应以一次性、独立、可审计的数据工具重新设计，而不是恢复产品双栈。
