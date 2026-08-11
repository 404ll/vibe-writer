# ADR-0020：Readiness 与 API/Article 原子切流

- 状态：Accepted
- 日期：2026-08-07

## 背景

Iteration 0018 已跑通 Worker composition，但部署系统仍无法区分“进程存在”和“依赖已就绪”。此外，浏览器 API 与文章 Server Component 使用两条配置链：只把 `NEXT_PUBLIC_API_BASE` 改为 `/api/durable`，新 job 会写 PostgreSQL，但 `/articles/:id` 首屏仍通过 `API_PROXY_TARGET` 查询 Python/SQLite，造成写入成功后页面 404 的分裂状态。

## 决定

1. Next.js 提供 `/api/durable/health/live` 与 `/api/durable/health/ready`。liveness只证明 HTTP进程能响应；readiness要求 `DURABLE_API_ENABLED=true`、数据库可连接且全部 durable业务表存在。
2. readiness失败只返回 `disabled` 或 `dependency_unavailable`，不暴露连接串、SQL、表名和内部错误。两个探针都使用 `cache-control: no-store`。
3. Worker可通过显式 `WORKER_HEALTH_PORT` 启用 `/live`、`/ready`；未配置端口时不额外监听。health host默认 `0.0.0.0`，部署可以覆盖。
4. Worker启动顺序为 health starting → database ping → PostgresSaver setup → BullMQ publisher/consumer ready → health ready。关闭先标记 draining，使 readiness立即失败，再停止 intake/dispatcher并关闭 queue、checkpoint、database和health listener。
5. Worker/API readiness独立。API ready不能推断 Worker ready；切流门禁必须同时检查两者，并运行一条真实 canary job。
6. Server Component文章读源由独立 runtime flag `DURABLE_ARTICLE_READ_ENABLED` 控制。默认 false继续读取 FastAPI；true时直接读取同一 PostgreSQL article repository。
7. durable切流必须把 build-time `NEXT_PUBLIC_API_BASE=/api/durable`、runtime `DURABLE_API_ENABLED=true` 与 `DURABLE_ARTICLE_READ_ENABLED=true` 视为一个发布单元，不允许只修改其中一项。
8. route当前没有 auth/tenant隔离，因此只允许在受限 staging网络验证；公开流量切换在 auth/tenant和历史数据迁移决策完成前为 No-Go。

## 不变量

- liveness不执行外部依赖查询，readiness不得在依赖未就绪时返回200。
- readiness不得替代业务 canary、数据迁移核对或 shadow eval。
- 新 job的 API写入源与文章读取源在切流后必须同为PostgreSQL。
- draining Worker不能继续被负载均衡器视为ready。
- 默认配置继续走Python基线，不因新增探针或读源分支而隐式切流。

## 未选择

- 用一个 `/health` 同时表示 live/ready：会让瞬时依赖故障触发错误的进程重启，或让未就绪实例接流量。
- API readiness顺便查询Redis/Worker：会把独立扩缩容组件耦合到一个脆弱的聚合探针。
- Server Component通过自身公开URL回调 `/api/durable/articles`：增加不必要的网络、host推导和自调用故障面。
- 继续只用 `API_PROXY_TARGET`：无法原子表达浏览器API与Server Component文章读源。
