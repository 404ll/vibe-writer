# Eval 0039：Memory Source Signal 工程基线

- 日期：2026-08-07
- 结论：Passed for explicit source persistence, retention, erasure, and workspace RLS; extraction integration not evaluated
- 对应迭代：[0043](../iterations/0043-explicit-user-memory-source-signals.md)

## Persistence Matrix

| 场景 | 预期 | 实际 |
|---|---|---|
| exact request replay | same signal, `created=false` | passed |
| idempotency key drift | collision, no overwrite | passed |
| viewer personal subject | own principal only | passed |
| viewer shared subject | permission error | passed |
| editor project/workspace subject | accepted | passed |
| principal impersonation | permission error | passed |
| cross-workspace/other-author run | rejected | passed |
| author delete | hard delete + content-free tombstone | passed |
| owner governance delete | hard delete + replayable receipt | passed |
| non-owner delete of another user | permission error | passed |
| database-time retention | source deleted + expiry tombstone | passed |
| non-owner DB role | current workspace only | passed on real PostgreSQL |
| missing DB scope | no signal or tombstone visible | passed on real PostgreSQL |

PGlite DB suite为16个文件、103项；真实PostgreSQL suite为15项，PostgresSaver为4项，live sampler为1项。migration drift check通过。

## 数据边界

signal row包含原始用户文本，因此受workspace RLS和最长期限365天约束。tombstone只包含source signal id、workspace、删除actor、reason和timestamp；测试断言删除后不再存在source row，tombstone序列化结果不含原始中文偏好。

## 未证明

- 没有HTTP/UI consent flow；
- extraction ledger仍以source run为主键，尚不能消费signal；
- candidate/revision尚无source signal外键，因而尚不存在derived deletion propagation；
- 没有outbox、BullMQ、真实extractor、cost或quality calibration；
- production Memory extraction仍为No-Go。
