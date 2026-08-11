# Eval 0027：Live Eval Candidate Governance 基线

- 日期：2026-08-07
- 结论：Passed for content-free live Eval candidate governance
- 对应迭代：[0031](../iterations/0031-live-eval-candidate-governance-foundation.md)

## Identity

| 项目 | 值 |
|---|---|
| component | `EvalCandidateRepository` |
| sampler | deterministic 10,000-bucket policy |
| source | completed durable run + current article fingerprint |
| candidate classification | `user_content` pointer |
| lifecycle | `pending_review → approved/rejected/expired` |
| isolation | explicit workspace predicate + PostgreSQL RLS |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| candidate rows without consent | 0 | 0 | Passed |
| raw content fields loaded/persisted | 0 | 0 | Passed |
| duplicate sampler candidates | 0 | 0 | Passed |
| viewer approvals | 0 | 0 | Passed |
| cross-workspace visible candidates | 0 | 0 | Passed |
| sampled/reviewed/expired event gaps | 0 | 0 | Passed |
| non-scoped API-role rows | 0 | 0 | Passed |

## 联合证据

- source query 只选择 run/job ids/status/workspace 与 article id/revision/fingerprint，不选择 job topic 或 article content；
- missing consent 在数据库事务前返回，表保持为空；
- stable bucket 决定 sample-rate inclusion，同一 source/sampler version 只创建一次；
- candidate JSON 不含测试文章 topic/body，只含 pointer、fingerprint、policy 与 lifecycle；
- viewer review 抛出 permission error，owner review 可幂等 replay；另一个 workspace 的 list/events 均为空；
- retention elapsed 后 maintenance transaction 写 `expired` 和 `retention_elapsed` event，再次 expiry 无重复；
- 真实 PostgreSQL 非 owner role 在 transaction-local workspace scope 下只看到对应 candidate/event，无 scope 时看不到任何行。

根级门禁另通过 TypeScript 362 项、Python 50 项，共 412 项测试，以及 38-case component gate、3-case workflow shadow、Web lint/build、全部 typecheck、migration check 和 102 个 Markdown 链接检查。

## 未证明

- 自动 scanner、托管 scheduler、cursor 重放、backlog 或多 region；
- consent assertion 的外部 policy source、撤回传播和删除审计；
- 去标识化、approved candidate materialization、grader 与质量指标；
- 加密、备份清理、CI artifact retention 和真实生产数据演练。
