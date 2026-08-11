# Eval 0025：Production Expired-Lease Takeover 基线

- 日期：2026-08-07
- 结论：Passed for synthetic production expired-lease takeover
- 对应迭代：[0029](../iterations/0029-production-expired-lease-takeover-projection-gate.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `production-takeover-regression@2026-08-07-v1` |
| dataset | `production-takeover-baseline-v1` |
| dataset fingerprint | `sha256:601bc40b1ebfd498e70b5a178fa4459f542c387f1bd01326fc195f3b7e0ee490` |
| target | `typescript-durable-production-takeover@v1` |
| metric | `durable_takeover_exact_match` |
| cases | expired lease with an uncertain planner effect |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| unique cases | 1 | 1 | Passed |
| target/evaluator errors | 0 | 0 | Passed |
| exact-match scores | 1 | 1 | Passed |
| pass rate | 1.0 | 1.0 | Passed |

规范化投影为：completed job、`runStatuses=[failed,completed]`、旧 run error `lease_expired`、一个 revision 0 article、done event、published outbox、effect/trace 各 5 个 succeeded + 1 个 uncertain、uncertain error `lease_takeover`、两个 trace id、五次真实 provider request，以及两个 stale-token 操作均为 `lease_lost`。

## 联合证据

- stale Worker 先 claim 并 reserve `model:plan:attempt:1`；
- lease 过期后 production Worker 创建 attempt 2，旧 run/effect/trace 原子收敛；
- attempt 2 对 uncertain key fail closed，不发送重复 provider request，再使用 `plan:attempt:2` 有界恢复；
- 最终 Markdown 命中 `happy-no-intervention` workflow expected；
- stale token 无法 finish effect 或把 completed job 改成 failed；
- durable API 返回两条不同 job 的稳定写作文章、恢复文章和 legacy article，Server Component 均可渲染；
- PostgreSQL、Redis 和 Next 在结束后停止。

根级门禁另通过 TypeScript 348 项、Python 50 项，共 398 项测试，以及 Web lint/build、全部 typecheck、migration check、38-case component gate、3-case workflow shadow gate 和 96 个 Markdown 链接检查。

## 未证明

- 真实进程 crash、network partition、BullMQ stalled delivery 与托管基础设施；
- uncertain effect 的 provider-side reconciliation；
- HTTP/SSE、真实 provider 质量与跨 region clock/latency。
