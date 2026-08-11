# Eval 0028：Automatic Live Eval Sampling 基线

- 日期：2026-08-07
- 结论：Passed for versioned content-free scanning on real PostgreSQL
- 对应迭代：[0032](../iterations/0032-automatic-live-eval-sampling.md)

## Identity

| 项目 | 值 |
|---|---|
| component | `EvalSamplingRepository` + `LiveEvalSamplerLoop` |
| policy | workspace-owned immutable sampler version |
| cursor | `(run.finished_at, run.id)` |
| concurrency | policy row `FOR UPDATE SKIP LOCKED` |
| fairness | `last_scanned_at ASC NULLS FIRST` |
| output | governed `eval_candidates` pointer + sampled event |
| process | independent `apps/eval` live sampler runtime |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| raw content fields loaded/persisted | 0 | 0 | Passed |
| owner-bypass policy writes | 0 | 0 | Passed |
| replacement historical rescans | 0 | 0 | Passed |
| duplicate/colliding candidates | 0 | 0 | Passed |
| missing-article cursor advances | 0 | 0 | Passed |
| concurrent policies scanned | 2 | 2 | Passed |
| non-scoped API-role policy rows | 0 | 0 | Passed |
| runtime first-tick candidates | 1 | 1 | Passed |

## 联合证据

- PGlite repository gate 覆盖 owner-only configuration、immutable version、cursor inheritance、bounded source batches、disabled policy、fair rotation 和 transaction rollback；
- architecture assertion 确认 scanner 不选择 article content/topic，也不依赖 provider、LangGraph 或 BullMQ；
- 真实 PostgreSQL trigger 延长 policy update 锁持有时间，两个独立 backend session 并发执行 `policyLimit=1`，各生成一个不同 workspace candidate；
- 非 owner role 在 transaction-local scope 下只看到对应 policy，无 scope 时返回空；
- 独立 runtime 完成 schema readiness 后立即执行首个 tick，candidate 只含 source article pointer/revision/fingerprint 和 policy metadata，测试正文不出现在序列化结果中；
- scanner runtime 不触碰 Eval execution queue，既有 component registration/enqueue 幂等检查继续通过。

根级门禁另通过 TypeScript 372 项、Python 50 项，共 422 项测试，以及 38-case component gate、3-case workflow shadow、Web lint/build、全部 typecheck、migration check 和 105 个 Markdown 链接检查。

## 未证明

- 托管 PostgreSQL/连接池代理、多 region 部署、真实 backlog 或长时间 soak；
- 对外 policy API、auth adapter、健康检查、metric/alert 和 scheduler 编排；
- consent 撤回、删除 tombstone、去标识化和 approved candidate materialization；
- 真实 grader、quality lift、cost budget、CI artifact 与 Memory Eval。
