# Eval 0042：Memory Cost Budget 故障基线

- 日期：2026-08-07
- 结论：Passed for deterministic pricing, pre-provider rejection, and cross-session reservation serialization; paid-model calibration not evaluated
- 对应迭代：[0046](../iterations/0046-durable-memory-cost-budget.md)

## Deterministic Cost Contract

| 场景 | 预期 | 实际 |
|---|---|---|
| strict policy/pricing | unknown field与非法cap拒绝 | passed |
| conservative reservation | UTF-8 input bytes + max output，包含三类input费率 | passed |
| actual settlement | 四类usage按固定pricing逐项向上取整 | passed |
| safe integer | BigInt中间计算，越界拒绝 | passed |
| max token drift | extractor与budget snapshot不一致时构造失败 | passed |

## Durable Fault Matrix

| 场景 | 预算占额 | provider调用 | 实际 |
|---|---:|---:|---|
| source cap不足 | 0 | 0 | passed |
| workspace daily cap不足 | 保留已有占额 | 0 | passed |
| 两session同时预留60/日限100 | 仅一个60 | 仅获批者可调用 | passed on real PostgreSQL |
| known failed且无cost | 释放最大预留 | 已知失败调用一次 | passed |
| reserved/uncertain | 保留最大预留 | 禁止自动重放 | passed |
| successful usage | 最大预留替换为实际cost | 一次 | passed |
| usage缺失/实际超预留 | 保留为uncertain | 禁止后续自动调用 | passed by Worker contract |
| 当日policy/pricing漂移 | 保留已有占额 | 0 | passed |

## 证据

- Memory core：26/26；
- PGlite DB：108/108；
- Worker：67/67；
- 真实PostgreSQL：18/18，另有PostgresSaver 4/4、live sampler 1/1；
- 真实Redis/BullMQ：9/9，run/signal均使用budget-enabled consumer；
- migration drift：0。

## 未证明

- 未调用付费Memory extractor，不能证明供应商真实usage字段或账单一致性；
- 未实现provider result lookup、账单导入或`uncertain` resolver；
- 未验证跨region数据库延迟、运营告警或workspace配置权限；
- 未启用staging/production consumer，也未做真实质量与answer-uplift Eval。
