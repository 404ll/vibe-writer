# Iteration 0021：Self-owned Eval 与 Run Trace 基础

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0022](../decisions/0022-self-owned-eval-and-bounded-run-trace.md)
- 评测记录：[Eval 0017](../evals/0017-self-owned-eval-trace-baseline.md)

## 目标

在不依赖 auth provider、Langfuse 或真实付费模型的前提下，为后续 Memory 与持续 Eval 建立可版本化、可查询、默认不保存正文的运行数据面，并把现有 fenced provider effect 投影为真实 PostgreSQL Trace。

## 范围内

- 新增纯 TypeScript `@vibe-writer/eval-core` 与离线 runner；
- 固定 dataset/target/execution/evaluator 版本和 canonical fingerprint；
- 默认只记录 output fingerprint，显式区分 target 与 grader 失败；
- 新增 suite/case/run/trial/score PostgreSQL schema 与 repository；
- suite 以 opaque namespace、key、version 和 dataset fingerprint 隔离；
- durable run 强制拥有 `trace_id`，旧 null run 由 migration 回填；
- effect reserve/finish/takeover/terminal 与 trace span 在同一 transaction 更新；
- Worker readiness 要求 `trace_spans` 与核心 durable relations 已迁移；
- production composition 证明 5 个真实 adapter model call 都生成有界 span；
- 更新系统设计、路线图、ADR、迭代和 Eval 证据。

## 范围外

- 不选择 auth provider，不创建 user/workspace/RLS；
- 不把真实生产正文注册为 Eval dataset；
- 不接 Langfuse、OpenTelemetry 或其他 vendor；
- 不实现 eval BullMQ queue、shadow sampler、CI quality gate 或收费 live model eval；
- 不实现 Memory candidate/retrieval；
- 不改变浏览器默认 API，也不执行真实 SQLite source migration。

## 关键实现

### Eval runner

`packages/eval-core` 只接收 case、target、evaluator 和不可变 execution snapshot。case/evaluator identity 重复、非 JSON 数据、非有限数值或空版本会 fail fast。target/evaluator exception 被转换成不包含原始异常正文的结构化错误；默认 report 不带 input、expected 和 output。

### Eval 数据库

`EvalRepository` 支持：

- versioned suite/case 注册与 dataset collision；
- 只允许 active suite 启动 run；
- trial exact replay 与 fingerprint collision；
- score 持久化；
- 完整 trial 数量门禁；
- 根据 trial/score error 推导 run completed/failed。

`namespace_key` 暂时是 opaque scope，目的是避免先把 Eval 数据做成全局表；它不解决真正的身份与授权问题。

### Trace

每个新旧 run 都获得非空 `trace_id`。Worker 的 `EffectJournalModel`/`EffectJournalSearchProvider` 把 operation 传给 DB；Job repository 在 effect transaction 内写 `trace_spans`。成功 span 抽取 token、latency 和 provider identity，失败/lease takeover/terminal cleanup 进入明确终态。任何 prompt、正文、query、URL、snippet 和 provider payload 都不会写入 span。

## 验证

- `pnpm test:eval-core`：2 个文件、5 项通过；
- `pnpm test:db`：9 个文件、57 项通过；
- `pnpm test:worker`：9 个文件、49 项通过；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 9 项 + PostgresSaver 4 项通过；
- `pnpm test:worker:production:local`：真实 PostgreSQL + Redis + Worker + local provider + Next.js + SQLite migration 联合链路通过，5 个 provider effect 对应 5 个 succeeded trace span；
- `pnpm check:migrations`：通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts 20、model 9、provider 5、eval 5、agent 93、workflow 48、DB 57、checkpoint 8、Worker 49、Python API 50、Web 27；migration、typecheck、lint、Next build 和 72 份文档链接全通过；
- `git diff --check`：通过。完整边界见 [Eval 0017](../evals/0017-self-owned-eval-trace-baseline.md)。

## 退出条件核对

1. Eval dataset 与 target 版本可重复指纹：满足。
2. target/grader failure 不会静默通过：满足。
3. Eval 数据由 PostgreSQL 自有且具有 namespace 前置字段：满足，但 auth/RLS 未满足。
4. run/effect trace 可查询且与 fenced transaction 一致：满足。
5. Worker 不会在 trace migration 缺失时误报 ready：满足。
6. 默认不保存执行正文：满足。
7. live/shadow Eval 可运行：未满足，明确留到后续迭代。

## 回滚

停止使用新 Eval repository 和 Trace 查询不会改变 job/article 核心读写。数据库回滚若需删除新表，必须先导出需要保留的 Eval/Trace 记录；`runs.trace_id` 可保留，不影响旧运行时。不能在已有生产数据上直接逆向删除 migration。

## 后续

1. auth/workspace 决策后，把 opaque namespace 绑定到强外键并设计 RLS/删除级联；
2. 建立 fixture suite 注册 CLI 与 CI regression baseline compare；
3. 增加 shadow sampler、独立 Eval queue 和 retention/consent policy；
4. 增加 node/queue/HTTP span 与可替换 Langfuse/OpenTelemetry adapter；
5. 在稳定 trace/run identity 上实现 Memory candidate、evidence 和专项 Eval。
