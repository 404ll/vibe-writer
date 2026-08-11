# Eval 0024：Production Provider Failure 基线

- 日期：2026-08-07
- 结论：Passed for synthetic production provider failure
- 对应迭代：[0028](../iterations/0028-production-provider-failure-projection-gate.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `production-failure-regression@2026-08-07-v1` |
| dataset | `production-failure-baseline-v1` |
| dataset fingerprint | `sha256:d15a470966bda9b5a18f2561d89d0599d8494ae7ab8b994fa7e06858cbd7e89c` |
| target | `typescript-durable-production-failure@v1` |
| metric | `durable_failure_exact_match` |
| cases | provider 503 after bounded planner retries |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| unique cases | 1 | 1 | Passed |
| target/evaluator errors | 0 | 0 | Passed |
| exact-match scores | 1 | 1 | Passed |
| pass rate | 1.0 | 1.0 | Passed |

规范化投影为：`jobStatus=failed`、job/run error code 为 `workflow_service_exception`、`articleCount=0`、`eventTypes=[error]`、`outboxStatuses=[published]`、两个 failed effect/trace、其 error code 均为 `provider_unavailable`，provider request count 为 2。

## 联合证据

- loopback provider 对两次真实 Anthropic wire request 返回 HTTP 503；
- 每次 provider 失败都由 effect journal 原子记录 failed effect/trace；
- workflow policy 在一次 retry 后终止，没有 adapter/queue 隐式无限重试；
- terminal transaction 提交 failed job/run 与 error event，dispatcher 发布 outbox；
- 没有 article，effect/trace 不包含 topic；
- completed/resume 与 cancellation production case 同轮继续通过；
- PostgreSQL、Redis 和 Next 在结束后停止。

根级门禁另通过 TypeScript 347 项、Python 50 项，共 397 项测试，以及 Web lint/build、全部 typecheck、migration check、38-case component gate、3-case workflow shadow gate 和 93 个 Markdown 链接检查。

## 未证明

- timeout、429、authentication、invalid response 与网络分区；
- run/job 级 retry、lease takeover 与旧 Worker fencing；
- HTTP/SSE、真实 provider 质量或托管基础设施。
