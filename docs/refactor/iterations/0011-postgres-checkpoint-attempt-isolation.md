# Iteration 0011：Postgres Checkpoint Attempt Isolation

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker cutover
- 对应决策：[ADR-0012](../decisions/0012-postgres-checkpoint-attempt-storage-and-fenced-pointer.md)

## 目标

把 workflow 从同进程 `MemorySaver` 推进到真实 PostgreSQL PostgresSaver，并用 per-run 物理 checkpoint thread、fork/activate 协议和 fenced pointer 保证进程重启可恢复、takeover 后旧 Worker 不能污染当前恢复点。

## 范围内

- `checkpoint_attempts` schema、forward migration 与 repository；
- `@vibe-writer/checkpoint-runtime` infrastructure adapter；
- 官方 PostgresSaver 独立 schema/setup 生命周期；
- attempt prepare/fork/activate、root pointer advance、pending writes 复制；
- strict scoped config、payload guard、graph-version compatibility；
- 真实 PostgreSQL interrupt/resume、chapter/terminal replay 与 takeover tests；
- ADR、系统设计、Iteration、Eval 和 reader closure。

## 范围外

- 不接 BullMQ consumer、Next.js API 或生产 provider；
- 不实现 terminal event/article transaction；
- 不实现托管 PostgreSQL/PgBouncer、KMS/envelope encryption 或备份恢复；
- 不实现完整 TTL scheduler、memory/RAG 或跨 graph-version自动 migration；
- 不删除 Python/FastAPI 运行路径。

## 必须证明的行为

1. 官方 PostgresSaver 在 `langgraph_checkpoint` schema setup 后可 put/get/list；
2. 顶层 attempt 使用独立物理 thread id，subgraph namespace 不越过 attempt；
3. 首次 run 激活空 checkpoint attempt，root put 后 pointer fenced 前进；
4. 新 attempt 从上一个稳定 root checkpoint fork，并复制 pending writes；
5. 相同 prepare/fork/activate 重试幂等；
6. takeover 后旧 token 的 put/putWrites/pointer advance 失败，新 attempt pointer 不变；
7. graph version 不兼容时拒绝 fork；
8. outline interrupt 可跨 saver/graph 实例 resume；
9. chapter checkpoint 与 terminal checkpoint 重放不重复已完成组件；
10. payload、config scope、schema 与 destructive test guard 有负例；
11. 全仓 verify、真实 PostgreSQL integration、文档链接与 reader closure 通过。

## 当前状态

已完成代码、真实 PostgreSQL 与全仓验证：

- `packages/db` 新增 `checkpoint_attempts`、forward migration 与 repository，固定 `preparing → active → superseded`、唯一 active attempt、graph-version guard 和 fenced root pointer；
- `packages/checkpoint-runtime` 包装官方 PostgresSaver，强制 per-run 物理 `thread_id`、root/subgraph pointer 分离、写前写后 lease 校验、payload/scope guard；
- prepare/fork/activate 采用 saver write-first、business pointer second；fork 复制 checkpoint envelope、metadata 和按 task 分组的 pending writes；
- 当前 LangGraph 1.4.9 顶层非空 `checkpoint_ns` 会被框架重置，因此 ADR-0012 已改用 per-run 物理 `thread_id` 隔离；
- 临时 PostgreSQL 14.20 已验证官方 saver 独立 schema、takeover、zombie put/putWrites 拒绝、pending writes fork、跨 saver/graph 实例 outline resume、terminal replay 和 chapter replay。

## 变更文件

- `packages/db/src/schema.ts`、`domain.ts`、`repositories/checkpoints.ts` 与新 migration；
- `packages/checkpoint-runtime/src/runtime.ts` 及 package architecture/unit/PostgreSQL tests；
- `scripts/run-postgres-integration.mjs`：同一个受保护的临时 cluster 依次运行 DB 与 checkpoint runtime suites；
- ADR-0012、Eval 0007、系统设计、路线图与文档索引。

## 当前验证

| 命令 | 结果 |
|---|---|
| `pnpm --filter @vibe-writer/db test` | 3 files / 30 tests passed |
| `pnpm --filter @vibe-writer/db typecheck` | passed |
| `pnpm --filter @vibe-writer/checkpoint-runtime test` | 2 files / 8 tests passed |
| `pnpm --filter @vibe-writer/checkpoint-runtime typecheck` | passed |
| `pnpm test:db:postgres:local` | PostgreSQL 14.20；DB 5/5，checkpoint runtime 4/4 passed；cluster 已停止并清理 |
| `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify` | passed；含 contracts/model/agent/workflow/db/checkpoint/worker/API/Web/docs |
| `git diff --check` | passed |

复核确认当前实现没有把 checkpoint 夸大为 provider exactly-once、长期 memory 或已切流的产品路径；未覆盖项保留在以下风险列表。

## 剩余风险

- 当前只验证本机直连 PostgreSQL，没有覆盖托管实例、PgBouncer、网络分区或备份恢复；
- checkpoint id 前进顺序依赖当前 LangGraph 生成的时序 UUID，升级 checkpointer/serializer 前必须重新跑本 Eval；
- payload guard 已有应用级默认上限，但 encryption、TTL、完成后压缩和 retention reconciler 尚未实现；
- checkpoint 只隔离 graph state；provider side effect 仍由 `run_effects`/幂等协议处理，不能宣称 exactly-once；
- BullMQ consumer、Next.js resume API、durable SSE projection 和 terminal article transaction 仍未接入。

## 回滚

当前 Python 路径与 TS Worker 尚未读取 checkpoint attempt。若 migration 未进入共享环境，可移除新 package/schema/test；若已应用，使用新的 forward compensating migration，不能改写已执行 migration 或直接删除官方 saver schema。
