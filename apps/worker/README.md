# @vibe-writer/worker

Node Worker 运行时。lease runner 负责取得数据库 fencing token、维持 heartbeat、把 lease lost/cancel 转为 AbortSignal，并以同一 token 进入 terminal transaction。Iteration 0012 已加入 outbox dispatcher、BullMQ 5.81 publisher/worker binding 与隔离 Redis harness；Iteration 0013 已加入 durable workflow executor、fenced checkpoint 组装和 article/terminal transaction routing。

Iteration 0016 已加入真实 Anthropic/Tavily HTTP adapter、production `WorkflowServices` composition 和默认关闭的进程入口；Iteration 0017 又用当前 run lease 把 TextModel/ToolModel/SearchProvider 调用接入 `run_effects`。Iteration 0061 已通过根目录`pnpm dev:durable`把Worker与Next durable routes组合成本地可用产品路径；公开生产切流仍受真实auth/Ingress与部署门禁约束。PostgresSaver attempt adapter 位于独立 `@vibe-writer/checkpoint-runtime`，数据库原子状态位于 `@vibe-writer/db`，本包不拥有 schema 或直接 SQL。

`DURABLE_WORKER_ROLE=dispatcher|consumer|all` 支持独立扩缩容。dispatcher必须使用`DATABASE_WRITE_DISPATCHER_URL + WRITE_DISPATCHER_DATABASE_ROLE`，consumer必须使用`DATABASE_WRITE_CONSUMER_URL + WRITE_CONSUMER_DATABASE_ROLE`；`all`也会建立两个连接且拒绝相同URL或role，不回退通用`DATABASE_URL`。consumer 还要求 Anthropic key/model；Tavily key可选，缺失时Writer不注册search tool。

当前产品MVP不包含Memory。production写作Worker显式关闭post-run Memory extraction，consumer也不持有`outbox_events` INSERT；仓库中的Memory worker/retention实现仅作为默认关闭的归档模块保留。

部署顺序固定为：受控Drizzle migration → `DATABASE_CHECKPOINT_ADMIN_URL=... pnpm setup:checkpoint-schema` → 创建两个login role → 运行`write-dispatcher-role:provision`与`write-consumer-role:provision` → 分别verify → `pnpm start:worker`。长期运行consumer不会调用PostgresSaver `setup()`，并在ready前从自身连接校验current role、精确schema/table权限、ownership和checkpoint schema完整性。

设置 `WORKER_HEALTH_PORT` 后会启用HTTP `/live`与`/ready`；host默认 `0.0.0.0`，可用 `WORKER_HEALTH_HOST`覆盖。readiness只有在两个启用角色的身份/权限、durable/checkpoint schema检查和对应BullMQ角色启动完成后为200；漏跑migration、checkpoint setup、role provision或拿错secret都会在接流前失败。shutdown开始会先进入draining并返回503。

进程收到 SIGTERM/SIGINT 后停止 dispatcher/consumer，再关闭 BullMQ、PostgresSaver 和数据库。effect journal 只保存 provider/model/request id/usage/latency 等 bounded metadata，不保存 prompt、响应正文或搜索内容；非首次安全 reservation 状态会 fail closed。Iteration 0021 起，effect reserve/finish 还会在同一数据库事务维护可查询的 `trace_spans`，lease takeover 或 terminal cleanup 会把未完成 span 标记为 uncertain。

`pnpm test:worker:production:local` 会创建一次性真实 PostgreSQL与Redis，由owner执行migration/checkpoint setup/seed，再用两个非owner角色和本地Anthropic协议服务器跑通production `role=all` composition。它验证completed、outline resume、cancellation、provider failure、lease takeover，以及dispatcher不能读Job、consumer不能读outbox、两者不能建schema、consumer不能执行checkpoint setup；不使用真实provider key，也不覆盖OS signal或网络分区。

Memory保留期维护使用独立DB-only进程，不需要Redis或模型凭据，并且默认关闭：

```bash
MEMORY_RETENTION_MAINTENANCE_ENABLED=true \
DATABASE_MEMORY_RETENTION_URL=postgresql://vibe_writer_memory_retention:...@.../vibe_writer \
MEMORY_RETENTION_DATABASE_ROLE=vibe_writer_memory_retention \
MEMORY_RETENTION_WORKER_ID=memory-retention-1 \
pnpm start:memory-retention
```

该进程不会回退到通用`DATABASE_URL`，启动前会从自身连接校验精确table权限、`BYPASSRLS`、role membership、ownership和schema边界。默认每批100条、正常轮询60秒、存在backlog时250毫秒继续排空、达到1000条时报告`backlog_alert`。可通过`MEMORY_RETENTION_BATCH_SIZE`、`MEMORY_RETENTION_POLL_MS`、`MEMORY_RETENTION_BACKLOG_POLL_MS`和`MEMORY_RETENTION_BACKLOG_ALERT_THRESHOLD`调整；可选health server使用`MEMORY_RETENTION_HEALTH_HOST/PORT`。角色provision/verify与故障处置见 [Memory retention maintenance runbook](../../docs/refactor/runbooks/memory-retention-maintenance.md)。
