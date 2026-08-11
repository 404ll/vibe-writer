# Eval 0046：Memory Calibration Execution 工程基线

- 日期：2026-08-09
- 结论：Passed for scripted quote, immutable approval binding, 72-trial execution, content-free metering, and fail-closed faults; live model quality and actual provider cost remain unevaluated
- 对应迭代：[0050](../iterations/0050-memory-calibration-bound-execution.md)

## Scripted execution

| 项目 | 结果 |
|---|---|
| dataset | tracked 24 cases / SHA-256 fingerprint |
| trials | 3 per case / 72 total |
| execution | provider-neutral `TextModel` |
| output capture | false |
| quality | precision/recall/accuracy/slot exact均为1，leak均为0 |
| metering | 72项usage、request id、response id、pricing version |
| production decision | false |

scripted reference output只证明runner和quality aggregation的工程语义，不是Anthropic模型结果，也没有产生付费账单。

## 故障矩阵

| 条件 | provider调用 | report/decision | 实际 |
|---|---:|---|---|
| 未审批manifest | 0 | execution拒绝 | passed |
| cost cap与quote差1 micro-USD | 0 | preflight拒绝 | passed |
| dataset fingerprint漂移 | 0 | preflight拒绝 | passed |
| approval后修改model | 0 | binding collision | passed |
| 72项scripted valid response | 72 | quality gate passed；production false | passed |
| 首项缺HTTP request id | 1 | contract error；剩余调用熔断 | passed |
| 首项unmetered provider failure | 1 | budget uncertain；剩余调用熔断 | passed |
| 72项invalid JSON | 72 | quality No-Go；完整计量保留 | passed |

## 数据与权限边界

- execution source不导入DB、BullMQ、provider runtime、Anthropic SDK或`fetch`；
- approval只绑定content-free execution identity，不含API key；
- model response只在单个trial评分期间存在，report不保存output；
- score metadata只含category、quality count、failure reason和structured metering；
- preflight CLI没有execute mode，默认输出`configuration_required`。

## 未证明

- 没有真实provider调用，不证明model质量、latency、usage字段稳定性或价格正确；
- 没有PostgreSQL approval audit、durable queue、lease/fencing或crash recovery；
- 没有actual invoice reconciliation；
- quality pass没有解除`request_level_terminal_lookup_unavailable`；
- production Memory extraction与automatic reconciliation继续No-Go。

## 验证证据

- Eval CLI：11个文件、46/46，类型检查通过；
- Eval graders：1个文件、5/5，类型检查通过；
- 根级`pnpm verify`通过，包含DB 116、Worker 78、API 50、Web 31与Next.js production build；
- `pnpm eval:memory-calibration:preflight`默认返回`configuration_required`且不执行provider调用；
- 160个Markdown链接与`git diff --check`通过。
