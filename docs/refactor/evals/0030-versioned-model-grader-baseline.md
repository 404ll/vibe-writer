# Eval 0030：Versioned Model Grader 工程基线

- 日期：2026-08-07
- 结论：Passed for versioned protocol, durable execution, and metered cost; model quality not evaluated
- 对应迭代：[0034](../iterations/0034-versioned-model-grader-and-cost-budget.md)

## Identity

| 项目 | 值 |
|---|---|
| target | `live-article-quality@v1` |
| rubric | `article-quality@2026-08-07-v1` |
| criteria | 5 fixed criteria, weighted locally |
| judge | injected `TextModel`, Anthropic adapter at composition only |
| trials | configurable 1–20; integration baseline = 2 |
| pricing | deployment-supplied immutable version + four token-class rates |
| budget | per-run max calls + max micro-USD |
| output retention | `captureOutput=false` |
| cost storage | structured `eval_scores` columns |

## 工程 Gate

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| provider calls when preflight budget rejects | 0 | 0 | Passed |
| accepted grader prose/additional fields | 0 | 0 | Passed |
| model-supplied final pass decisions | 0 | 0 | Passed |
| queue messages containing article content | 0 | 0 | Passed |
| trial output copies | 0 | 0 | Passed |
| metered completed trials | 2 | 2 | Passed |
| structured provider/model/token/cost rows | 2 | 2 | Passed |
| execution identity drift accepted | 0 | 0 | Passed |

## 联合证据

- fixed rubric response 只接受五个 criterion 的 exact key、整数 score 和 machine-readable reason code；weighted score、minimum criterion gate 和 pass/fail 由本地代码计算；
- 两个 trial 分别调用 Anthropic wire adapter，usage 以 input/output/cache classes 计价，并在同一个 per-run budget 中累计；
- Redis/BullMQ job 仍只有 `schemaVersion + evalRunId`，Worker 从 PostgreSQL claim suite/cases/run；完成时 trial、score、metering 与 run terminal state 原子提交；
- `eval_scores` 可直接查询 provider、model、request id、四类 token、micro-USD cost、pricing version 和 USD currency；criteria/budget/failure reason 留在 bounded metadata；
- 已付费调用但 response drift 的 evaluator error 仍携带 model metering，不把失败调用伪装成零成本；
- approved article 只作为 evaluator subject 在进程内存在，trial output 为 null，queue payload 和 score metadata 不保留正文。

根级门禁另通过 TypeScript 387 项、Python 50 项，共 437 项测试，以及 38-case component gate、3-case workflow shadow、Web lint/test/build、全部 typecheck、migration check 和 111 个 Markdown 链接检查。真实 PostgreSQL 联合门禁通过 DB 13 项、PostgresSaver 4 项和 live sampler 1 项。

## 未证明

- 没有调用付费外部模型，所以没有 judge-human agreement、稳定性、bias、跨语言表现或真实文章质量结论；
- loopback usage/cost 是确定性 fixture，不验证部署填写的模型价格；
- 没有并行 trial、跨 Worker budget ledger、workspace quota、预算告警或异常账单 reconciliation；
- 没有 CI artifact、趋势对比、Langfuse export、API/UI 或自动 live enqueue；
- 当前 materialized case 不含原始 writing task，因此 rubric 不测 instruction adherence。
