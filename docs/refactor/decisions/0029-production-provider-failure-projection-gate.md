# ADR-0029：Production Provider Failure Projection Gate

- 状态：Accepted
- 日期：2026-08-07

## 背景

Cancellation gate 已证明外部调用结果未知时使用 uncertain 收敛，但 production projection 仍没有覆盖供应商明确返回失败的路径。若 failure 与 cancellation 共用 expected，就无法区分“调用已确认失败”和“调用被中止、最终副作用未知”，也无法约束 workflow 的重试预算。

## 决定

1. 建立独立的 `production-failure-baseline-v1` dataset、target、suite、observation schema 和 tracked baseline。
2. loopback Anthropic server 对每次真实 wire request 返回 HTTP 503；不在 adapter 或 queue 层增加隐式重试。
3. Planner 的 component policy 允许一次有界重试，因此 projection 必须固定两次 provider request、两个 failed effect 和两个 failed trace，随后终止；改变预算必须显式提升 dataset/suite 版本。
4. effect/trace 保存底层 `provider_unavailable` 供诊断；workflow 对 job/run 暴露稳定的 `workflow_service_exception`，避免业务终态依赖供应商错误分类。
5. terminal transaction 原子提交 failed job/run、error event 和 outbox；不得生成 article，不得把 topic 写入 effect/trace。
6. lease takeover 继续使用独立 schema/baseline，不能用 failure case 代替 fencing 证据。

## 结果与限制

该 gate 证明真实 provider 5xx 会经过明确的两次领域尝试后收敛到 durable failed terminal，且诊断层与业务层错误码各自稳定。

它仍不证明 timeout、429、认证失败、部分响应、网络分区、queue retry、真实 provider 或进程强杀。当前 failure 不自动重排 job；未来若增加跨 run retry，必须单独定义预算、幂等与 Eval expected。
