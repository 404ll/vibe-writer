# Eval 0029：Approved Live Eval Materialization 基线

- 日期：2026-08-07
- 结论：Passed for owner-approved, retention-bound user-content datasets
- 对应迭代：[0033](../iterations/0033-approved-live-eval-materialization.md)

## Identity

| 项目 | 值 |
|---|---|
| component | `EvalMaterializationRepository` |
| source | approved `eval_candidate` + current article |
| materializer | `approved-article-copy@v1` |
| batch | 1–100 candidates, all-or-nothing |
| classification | `user_content` |
| initial suite status | `draft` |
| deletion | retention purge + source FK cascade |
| isolation | suite-parent RLS for case/run/trial/score |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| non-owner materializations | 0 | 0 | Passed |
| pending/stale candidate materializations | 0 | 0 | Passed |
| partial batch commits | 0 | 0 | Passed |
| duplicate materialized cases | 0 | 0 | Passed |
| generic user-content suite bypass | 0 | 0 | Passed |
| expired/source-deleted retained cases | 0 | 0 | Passed |
| no-scope API-role visible cases | 0 | 0 | Passed |
| fingerprint-corrupted runs started | 0 | 0 | Passed |

## 联合证据

- 两个 approved candidate 逆序提交后形成一个 draft suite、两个唯一 linked cases 和两个 materialized events；同输入 replay 返回原 suite；
- article revision/content fingerprint 在 approval 后被修改时，suite/case 均不创建，candidate 保持 approved；
- materialized candidate 到期后 case 被删除、suite 被 archived、event 序列为 sampled/approved/materialized/expired；
- owner activation 可幂等 replay，case input 被篡改后 `startRun` 因 immutable dataset fingerprint 不匹配而拒绝；
- generic repository 仍支持 synthetic/deidentified dataset，但显式拒绝 `user_content`，真实正文只能经 governed materializer；
- 真实 PostgreSQL 首轮门禁发现 `eval_cases` 旧有 parent policy 未实际启用 RLS；新增 case/run/trial/score RLS 后，non-owner role 在 workspace scope 下可见 1 个 case、无 scope 可见 0 个；
- 删除 source job 会级联 candidate 和 materialized case，case 查询返回 0；既有 Eval queue register/enqueue gate 未受影响。

根级门禁另通过 TypeScript 379 项、Python 50 项，共 429 项测试，以及 38-case component gate、3-case workflow shadow、Web lint/build、全部 typecheck、migration check 和 108 个 Markdown 链接检查。

## 未证明

- PII redaction/deidentification 质量、expected/rubric 构造与真实 grader；
- 大于 1 MiB 文章的 chunk materializer、异步批次、crash resume 和高并发；
- 托管数据库、备份/replica retention、字段加密和审计导出；
- API/UI authorization、CI artifact、质量提升和 cost budget。
