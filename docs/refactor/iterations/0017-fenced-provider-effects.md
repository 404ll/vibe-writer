# Iteration 0017：Fenced Provider Effects

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker/API cutover
- 对应决策：[ADR-0018](../decisions/0018-fenced-provider-effects-and-metadata-trace.md)

## 目标

把 production provider 调用接入已有 `run_effects`，以 replay-stable key、lease fencing 和最小元数据表达模型/搜索副作用，同时阻止敏感正文进入 journal。

## 范围内

- graph → Agent service → tool loop 的确定性 `effectScope`；
- TextModel、ToolModel 和 SearchProvider 的 reserve/finish wrapper；
- per-run WorkflowServices factory 与 production composition 接线；
- success/failure/uncertain/replay fail-closed 语义；
- metadata allowlist 与 prompt/response/search content 非持久化测试；
- PGlite 真实 repository 集成、相关组件回归和文档。

## 范围外

- 不实现 provider-side idempotency、结果读取、uncertain resolver 或自动 retry policy；
- 不把 journal 当成 Langfuse/OTel trace，不保存完整 transcript；
- 不执行收费 Anthropic/Tavily live call；
- 不完成 PostgreSQL + Redis + production process 的同一 harness E2E；
- 不切换浏览器流量，不处理认证/tenant 与 SQLite backfill。

## 实现结果

- graph 为 plan、outline revise、coverage、write、chapter review、full review 生成稳定 scope；Writer tool loop 把 tool/round/call 传给 search，ToolModel 按同一 node scope 分配稳定 request ordinal。
- Worker wrapper 在外部调用前用完整 request 的 canonical SHA-256 fingerprint reserve；非首次可安全执行状态全部 fail closed。
- 成功只落 provider/model/request id/usage/latency/stop reason/document count；测试证明 prompt、响应正文、query、URL 和 snippet 不进入 metadata。
- provider error 只落 bounded code/message；finish 失去 lease 会向上失败，不把已失去所有权的结果标成成功。
- production executor 按 run 构造 journal wrapper 与 WorkflowServices，避免跨 run 复用 lease identity 或 model request ordinal。
- PGlite 集成证明真实 JobRepository 能保存 succeeded effect，run terminal 不会把已完成 effect 误标 uncertain。

## 验证证据

- `pnpm --filter @vibe-writer/worker test`：47/47；含 effect journal unit 与真实 PGlite repository 集成。
- `pnpm --filter @vibe-writer/worker typecheck`：通过。
- `pnpm --filter @vibe-writer/agent-core test`：93/93。
- `pnpm --filter @vibe-writer/workflow-runtime test`：48/48。
- 全量、真实 PostgreSQL、真实 Redis 与文档检查见 [Eval 0013](../evals/0013-fenced-provider-effects-baseline.md)。

## 遗留边界

- `previously_succeeded`/`uncertain` 当前只能停住；没有可恢复结果或 provider resolver 时不能自动继续。
- `run_effects` 不是完整 trace；仍需 observability port、采样/脱敏/retention 和 eval case 回灌。
- 分离的 PostgreSQL 与 Redis 回归不能证明 production composition 在同一进程、同一故障注入下正确；联合 staging harness 仍是切流门禁。
- live provider 账号、限流、网关、真实质量和成本尚未验证。
