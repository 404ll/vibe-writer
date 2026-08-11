# Eval 0026：Independent Durable Eval Queue 基线

- 日期：2026-08-07
- 结论：Passed for synthetic durable Eval delivery
- 对应迭代：[0030](../iterations/0030-independent-durable-eval-queue.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `component-regression@2026-08-07-v1` |
| dataset | 38-case synthetic component fixtures |
| target | `typescript-agent-components@v1` |
| queue schema | `eval.run/v1` |
| queue payload | `{schemaVersion, evalRunId}` |
| persistence mode | queued + leased + fenced atomic commit |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| queue payload bytes | <= 1024 | pointer only | Passed |
| completed Eval runs | 1 | 1 | Passed |
| persisted trials | 38 | 38 | Passed |
| persisted scores | 38 | 38 | Passed |
| captured outputs | 0 | 0 | Passed |
| write queue jobs consumed by Eval | 0 | 0 | Passed |
| outbox rows published | 1 | 1 | Passed |

## 联合证据

- PostgreSQL transaction 同时创建 queued run 与 `eval.run.requested` outbox；相同 idempotency key 只返回同一 run；
- dispatcher 只 claim `aggregate_type=eval_run`，BullMQ job id 由 run UUID 稳定派生；
- real Redis 中的 job data 不含 case、expected、prompt 或 output；
- worker claim 数据库 lease 后从 PostgreSQL 加载 immutable suite/cases，验证 dataset 与 execution identity，再执行 component target；
- 38 trial/score 与 terminal run 在一个 fenced transaction 落库，trial output 均为 `NULL`；
- 同一 Redis prefix 下的 `vibe-writer-write` job 保持 waiting，证明独立 consumer 不抢用户工作负载；
- repository gate 另覆盖过期 lease takeover、stale heartbeat/fail 拒绝和 report identity mismatch fail-closed。

根级门禁另通过 TypeScript 357 项、Python 50 项，共 407 项测试，以及 38-case component gate、3-case workflow shadow、Web lint/build、全部 typecheck、migration check 和 99 个 Markdown 链接检查。既有 production composition 4 项也通过，证明 outbox lane 分离未破坏写作主链。

## 未证明

- 托管 Redis/PostgreSQL、跨 region、network partition、进程 kill 与长时间 stalled redelivery；
- live/user-content sampling、workspace RLS worker role、consent/retention 与删除传播；
- 真实模型质量、grader 稳定性、成本配额和 CI artifact retention；
- Eval cancel、reconciler、priority 和 backlog SLO。
