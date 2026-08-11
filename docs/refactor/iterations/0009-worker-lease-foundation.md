# Iteration 0009：Worker Lease 与 Fencing 基础

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker cutover
- 对应决策：[ADR-0005](../decisions/0005-durable-job-state-and-event-ordering.md)、[ADR-0010](../decisions/0010-worker-lease-and-fencing-protocol.md)

## 目标

建立 Node Worker 的第一条 durable execution 边界：数据库原子 claim、heartbeat、取消观察、过期接管与 token-fenced settle。当前迭代不运行真实模型，也不切换 FastAPI；先证明重复投递和 zombie Worker 不能破坏业务状态。

## 范围内

- 为 job/run 增加 lease token 与数据库约束、forward migration；
- `JobRepository` 增加 claim、heartbeat、cancel、settle；
- claim transaction 分配 run attempt 与不可复用 fencing token；
- `apps/worker` 建立 queue-neutral runner、heartbeat loop、AbortSignal 与 settle 编排；
- PGlite repository 集成测试与 scripted Worker fault tests；
- ADR、系统设计、Iteration 和 Eval 记录。

## 范围外

- 不接 BullMQ/Redis，不启动真实 queue consumer；
- 不接 PostgresSaver，不证明进程重启后的 graph resume；
- 不接真实 model/search/provider 或 Langfuse；
- 不实现 outline reply API、SSE projection、article/export transaction；
- 不切换 Next.js API 或 FastAPI/Python 运行路径；
- 不用 PGlite 结论代替真实 PostgreSQL 多连接与网络 fault test。

## 必须证明的行为

1. 同一 PGlite client 上用 `Promise.all` 重叠发起的两个重复 claim 只有一个成功且只创建一个 run；真实 PostgreSQL 多连接竞争另行验证；
2. lease 未过期时其他 Worker 不可接管；过期后新 claim 创建 attempt 2；
3. 新 claim 后旧 token 的 heartbeat 和 settle 都被拒绝；
4. heartbeat 使用数据库时钟续期 job 与 run；
5. running job 的 cancel request 使 heartbeat 返回 `cancel_requested`，并阻止新 claim；
6. settle 同事务终结 job/run、清空 lease，重复 settle 无副作用；
7. Worker runner 在 lease lost/cancel requested 时 abort，异常路径以 fenced settle failed；
8. DB 包不依赖队列/graph/provider，Worker 不拥有 schema 或直接 SQL；
9. migration check、相关 test/typecheck 与全仓 verify 通过；
10. 未验证的真实 PostgreSQL/BullMQ/PostgresSaver 边界进入 Eval 0005。

## 当前状态

已实现：

- `jobs` / `runs` 新增 `lease_token`、running/lease shape 约束与 forward migration；populated v1→v2 升级测试证明旧 unfenced running run 会终止、未取消 job 会重排队、已请求取消 job 会收敛为 cancelled，遗留 heartbeat 会清空；
- `JobRepository.claimJob()` 使用 DB `now()` 原子取得 queued/expired job、生成 token、分配 run attempt，并终止旧 expired run；
- `heartbeatClaim()` 同时续期 job/run，区分 renewed、cancel requested 与 lease lost；
- `settleClaim()` 同事务 fenced terminal transition，并处理完成与取消请求竞争；
- `requestCancellation()` 对 queued/awaiting-input 立即取消，对 running 写持久化请求；
- claim 拒绝 `prototype-unbound`、空版本或空 toolset，run 表同时约束关键版本字段非空；
- 通用 `transitionJob()` 不再允许进入/退出 running，公开 `createRun()` 已移除，避免绕过 claim；
- `apps/worker` 提供 queue-neutral runner、heartbeat loop、AbortSignal、失败信息净化和 fenced settle；
- DB 16 项、Worker 10 项窄测试及双方 typecheck、migration check 当前通过；其中 duplicate claim 证据限定为单个 PGlite client 上的重叠调用，不代表真实 PostgreSQL 多连接锁竞争。

明确保留到 R5 后续集成：

- 当前 fencing 只覆盖 job/run claim、heartbeat、cancel/settle；`appendEvent()`、checkpoint、article/export 与 tool-call journal 尚未要求 lease identity；
- PostgresSaver 与 job lease 已分责，但 takeover 后的 checkpoint namespace/旧 attempt 写入隔离尚未设计；
- `AbortSignal` 是协作式中止，不是忽略 signal 的 provider/tool 或外部副作用的安全边界。

最终验证：contracts 19、model-runtime 9、agent-core 92、workflow-runtime 47、DB 16、Worker 10、Python API 50、Web 12；全部相关 TypeScript typecheck、Drizzle migration check、Web lint、Next.js production build、34 份 Markdown 链接检查和 `git diff --check` 通过。架构、代码和 Eval 三类独立读者 closure 已完成；完整环境、artifact hash、dirty-worktree 与未验证边界见 [Eval 0005](../evals/0005-worker-lease-fault-baseline.md)。

## 本轮暴露并修复的问题

- 初版 forward migration 只处理带旧 lease 字段的 running row，可能被 v1 合法的无 lease running 数据阻断：改为迁移所有旧 running job/run，并新增 populated v1→v2 升级测试；
- 已请求取消的旧 running job 原本会重排为不可 claim 的 queued：改为迁移到 cancelled；
- job lease shape 原本未约束 heartbeat：现在 owner/token/expiry/heartbeat 必须同时为空或非空，migration 清理 stray heartbeat；
- settle 初版未把 DB-time lease expiry 纳入授权：现有 heartbeat/settle 都拒绝过期 token，接管前后均有回归；
- completion 与 cancel request 竞争原本无法区分：settle 返回 `cancel_requested`，runner 再以原 token 收敛 cancelled；
- 通用 transition/create-run 路径原本可绕过 running lease：现已收紧/移除；
- 文档初版把 duplicate claim 和 zombie 安全外推过宽：证据现限定为 single-client PGlite 控制面，event/checkpoint/export/tool 边界明确留到后续 R5。

## 回滚

当前 Python 运行路径不读取新增字段或 Worker package。若尚未部署到共享数据库，可移除本轮 package/repository 代码并在一次性测试库重建；若 migration 已应用，使用新的 forward migration 移除约束/字段，不改写 migration history。

后续进展：Iteration 0010 已在真实 PostgreSQL 独立连接下验证 claim/takeover，并用 fenced `appendRunEvent()` 与 `run_effects` journal 替代本轮记录的 generic event/effect 缺口；PostgresSaver 与 terminal transaction 仍未完成。
