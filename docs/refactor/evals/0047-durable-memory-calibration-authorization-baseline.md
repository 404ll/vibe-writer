# Eval 0047：Durable Memory Calibration Authorization 工程基线

- 日期：2026-08-09
- 结论：Passed for durable owner approval, atomic Eval enqueue, workspace RLS, and scripted queued execution; no paid provider calibration was run
- 对应迭代：[0051](../iterations/0051-durable-memory-calibration-authorization.md)

## 状态与事务矩阵

| 条件 | 结果 |
|---|---|
| editor/viewer registration | permission error |
| exact registration replay | 复用draft authorization |
| 相同幂等键、不同binding | collision |
| 未审批enqueue | 拒绝且无run/outbox |
| 预期fingerprint漂移 | approval/enqueue拒绝 |
| owner approval | DB timestamp、approval id、reason与event写入 |
| first enqueue | authorization、Eval run、outbox、event原子提交 |
| enqueue replay | 复用相同Eval run |
| Worker identity drift | provider调用前拒绝 |
| matching scripted run | 24 cases × 3 trials完成，output capture关闭 |

## 数据与权限证据

- authorization保存strict binding与base execution，不保存API key或model output；
- event序列固定为`created -> approved -> enqueued`；
- authorization和event均启用workspace RLS；event只为应用role声明SELECT/INSERT policy；
- 真实PostgreSQL non-owner role在无scope时读不到记录，第一workspace scope只能读取自己的authorization/event；
- enqueue复用`eval_runs`、`eval.run.requested` outbox、既有lease/heartbeat/report fencing。

## 未证明

- 未选择或调用真实Anthropic model；
- 未证明真实quality、latency、usage稳定性、pricing正确性或invoice一致；
- 未进行Worker crash发生在provider返回前后的unknown-outcome恢复；
- request-level terminal lookup仍不可用，automatic reconciliation保持关闭；
- production Memory extraction与active Memory自动写入保持No-Go。

## 验证证据

- Eval core 10/10、Eval graders 5/5；
- Eval CLI 47/47，其中scripted queue executor完成72次调用；
- PGlite authorization/architecture 19/19；
- 真实PostgreSQL DB 20/20、checkpoint 4/4、live sampler 1/1；
- 根级`pnpm verify`通过，包含DB 119、Worker 78、API 50、Web 31与Next production build；
- 163个Markdown链接与`git diff --check`通过。
