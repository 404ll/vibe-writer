# Iteration 0016：Provider 与 Worker Composition

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker/API cutover
- 对应决策：[ADR-0017](../decisions/0017-provider-adapters-and-worker-process-boundary.md)

## 目标

把 scripted TS workflow 组装为默认关闭、配置可验证、可独立扩缩 dispatcher/consumer、可优雅关闭的真实 Worker 进程，并固定 provider 协议基线。

## 范围内

- Anthropic Text/ToolModel adapter；
- Tavily SearchProvider adapter；
- outline revise service 与版本；
- style/AbortSignal 执行上下文贯穿；
- production WorkflowServices 与 composition root；
- dispatcher/consumer/all role、配置校验、SIGTERM/SIGINT lifecycle；
- 无密钥协议测试、scripted 集成、Redis/PostgreSQL/full verify；
- ADR、Eval 和运行说明。

## 范围外

- 不启用 durable API 或切产品流量；
- 不在仓库保存或读取真实 secret，不强制执行收费 live model smoke；
- 不实现 provider-side idempotency/result resolver、预算账户或 trace backend；
- 不实现托管部署、认证/tenant 或 SQLite backfill。

## 实现结果

- provider-runtime 已覆盖 Anthropic text/tools/error 与 Tavily request/response/error mapping。
- workflow 已把 style 和 cancellation signal传到所有 service；outline revise 不再是测试替身。
- production composition 已组装 PostgreSQL、PostgresSaver、BullMQ、provider、services、executor 和 durable command source。
- process runtime支持 dispatcher/consumer/all 与有序、幂等关闭；consumer配置缺 key/model时启动前失败，dispatcher可无模型凭据独立运行。
- production entrypoint 固定 model/prompt/graph/tool/code revision，支持 Redis TLS URL、队列 namespace、lease/heartbeat/concurrency/outbox poll配置；业务 migration仍是部署前置步骤。
- Worker CLI 在未显式 enable 时输出结构化 fatal并以非零状态退出；未发真实模型/搜索请求。

## 验证证据

- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model runtime 9、provider runtime 5、agent core 93、workflow 48、DB 47、checkpoint 8、worker 40、Python API 50、Web 22；typecheck/migration/lint/build/docs全通过。
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 9/9、PostgresSaver 4/4，临时服务已停止。
- `pnpm test:worker:redis:local`：真实 Redis/BullMQ 8/8，临时容器已停止。
- `env -u DURABLE_WORKER_ENABLED pnpm start:worker`（沙箱外，仅为绕过 tsx IPC）：输出 `worker.startup` fatal并以 1 退出，未建立外部连接。
- `git diff --check` 与 Markdown link check通过。

## 遗留边界

- 未使用收费 key执行 Anthropic/Tavily live smoke；协议测试不等于供应商当前账号、模型和网关可用。
- 尚无把真实 provider call写入 fenced `run_effects`/trace的 observer，provider-side不确定结果仍缺 resolver。
- 尚未完成同一 harness内的 Postgres + Redis + production composition进程 E2E、部署健康检查和 drain超时验证。
- durable API仍默认关闭，产品流量没有切换。
