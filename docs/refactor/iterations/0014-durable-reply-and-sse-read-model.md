# Iteration 0014：Durable Reply 与 SSE Read Model

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker/API cutover
- 对应决策：[ADR-0015](../decisions/0015-durable-interrupt-command-and-api-cutover.md)

## 目标

把 outline interrupt → user reply → requeue → checkpoint resume 做成 PostgreSQL 可恢复链路，并建立与现有前端兼容的 durable event history/SSE read model，不提前切换产品流量。

## 范围内

- `job_interrupts` / `job_commands` schema、migration 和 repository；
- pause transaction 持久化 interrupt id/payload；
- reply 幂等、collision、queued + resume outbox 原子事务；
- Worker 从 interrupt checkpoint 读取 command 并 `resumeOutline()`；
- queued/awaiting-input cancel event 完整性；
- durable jobs/events/SSE Route Handler 的独立路径与测试；
- reconnect/after-seq/terminal close/keepalive 边界；
- ADR、Eval、系统设计和验证记录。

## 范围外

- 不把当前 `/api/*` rewrite 切离 FastAPI；
- 不接真实 Anthropic/Tavily provider或生产 dispatcher supervisor；
- 不实现认证、tenant/RLS、Redis Pub/Sub 优化；
- 不迁移 SQLite 历史文章；
- 不删除 Python/FastAPI。

## 必须证明的行为

1. pause 原子写 interrupt、outline event、awaiting job 和 run terminal；
2. reply 原子写 command、replied interrupt、queued job 和唯一 resume outbox；
3. 同 reply replay，不同 payload collision；
4. takeover/retry 只对匹配 interrupt 应用一次 command；
5. reply 后 graph 从 interrupt checkpoint 完成且 plan 不重复；
6. events after-seq 连续、SSE replay 后收到 terminal 并关闭；
7. cancelled queued/awaiting job 有 cancelled event；
8. 未配置/未启用 durable API 时不影响 FastAPI rewrite；
9. 全仓、真实 PostgreSQL/Redis、migration/docs/diff check 通过。

## 实现结果

- 新增 `job_interrupts` / `job_commands` schema、migration 和 repository。pause transaction 持久化 LangGraph interrupt id + outline payload；reply transaction 固定 single-command、payload fingerprint/collision、`awaiting_input → queued` 与 resume outbox 原子提交。
- `DurableWorkflowExecutor` 恢复 checkpoint 后先判断它是否仍停在 interrupt：只有匹配 durable command 时才调用 `resumeOutline()`；checkpoint 已前进时只 replay，避免 command 重复应用。
- Worker/PGlite 端到端覆盖 `interrupt → pause → reply → second claim → resume → article/done`，Planner 与 Writer 各只调用一次。
- queued/awaiting-input cancellation 现在原子追加 `cancelled` event；pending interrupt 同事务转为 cancelled，不再出现 terminal state 没有 terminal event。
- Outbox dispatcher 支持 `job.resume.requested`。初次 delivery 继续用 `write-{jobId}`；resume 改用 `resume-{outboxEventId}`。真实 Redis 验证了复用初次 id 会触发 BullMQ completed-job dedupe，因此 distinct deterministic delivery id 是正确性边界，不只是命名变化。
- Next.js 新增默认关闭的 `/api/durable/jobs`、reply、cancel、events 和 fetch-SSE Route Handler。它们使用共享 Zod contract、PostgreSQL repository、after-seq polling、keepalive 和 terminal close；现有 `API_BASE=/api` 与 FastAPI rewrite 未改变。
- `DURABLE_API_ENABLED` 不是字符串 `true` 时 route fail-closed 503；本地 production build smoke 验证首页 200、durable POST 503。未配置 flag 不会创建数据库连接。

## 验证证据

- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model runtime 9、agent core 92、workflow 47、DB 44、checkpoint 8、worker 36、Python API 50、Web 18，migration/typecheck/lint/build/docs 全通过。
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 8/8、PostgresSaver 4/4；两个独立 session 同 reply 得到 queued/replayed，只有一条 command 和 resume outbox。
- `pnpm test:worker:redis:local`：真实 Redis/BullMQ 8/8；新增 durable reply 经 resume outbox 触发第二次 claim 并完成唯一 article/done。
- Next build 输出 5 个 `/api/durable/jobs*` dynamic routes；`next start -H 127.0.0.1 -p 4319` smoke：`GET /` 200，disabled durable POST 503。
- `git diff --check` 通过；临时 PostgreSQL 已停止，Redis 临时容器使用 `--rm`。

## 遗留边界

- durable route 仍是独立且默认关闭的 staging API，浏览器没有切换 `API_BASE`。
- 当前没有生产 outbox dispatcher/Worker composition root 和真实 provider，启用 create 只保证 job/outbox 已持久化，不保证有人消费。
- durable article list/detail/edit/version Route Handler 尚未实现；TS article id 不能在现有 Python article page 中解析，因此不能单独切 jobs API。
- SSE 当前使用 PostgreSQL 有界轮询保证正确性；Redis notification、连接上限、部署 drain 和代理超时尚未验证。
- authentication、tenant/RLS、rate limit、CSRF 与 data migration 是正式切流前门槛。
