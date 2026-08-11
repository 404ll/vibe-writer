# Eval 0040：Typed Memory Source 与 Erasure 基线

- 日期：2026-08-07
- 结论：Passed for typed proposal sources, trusted signal binding, and database-derived erasure; signal extraction delivery not evaluated
- 对应迭代：[0044](../iterations/0044-typed-memory-evidence-sources.md)

## Tracked Policy Gate

- suite：`memory-governance-regression@2026-08-07-v2`；
- target：`memory-policy-and-review-transition@2026-08-07-v2`；
- baseline：`apps/eval/baselines/memory-governance-v2.json`；
- dataset fingerprint：`sha256:4e8807cc9047630033f2ecd22434c53538c1424b6296e397cd823b84f8b79f2b`；
- 结果：20/20 exact match，target/evaluator error均为0；
- 新增覆盖：合法`kind=signal` proposal、untagged legacy source fail closed。

v1 baseline保留为历史记录；当前CLI和测试只比较v2。该suite不保存proposal output正文，也不调用模型。

## Persistence 与 Erasure Matrix

| 场景 | 预期 | 实际 |
|---|---|---|
| run source | completed run + same workspace | passed |
| signal source | existing, unexpired, same workspace | passed |
| forged evidence | reject before candidate | passed |
| forged subject | reject before candidate | passed |
| forged consent policy | reject before candidate | passed |
| expiry beyond signal retention | reject before candidate | passed |
| exact signal proposal replay | same typed source slot | passed |
| delete signal | candidate/event/Memory/revision cascade | passed on PGlite and real PostgreSQL |
| deletion receipt | content-free signal tombstone remains | passed |

## 未证明

- extraction ledger、outbox和queue仍为run-only；
- 没有signal自动enqueue或真实provider调用；
- 没有并发删除与in-flight provider reservation故障测试；
- 没有embedding/cache副本；
- 没有HTTP/UI consent flow、付费cost calibration或production shadow；
- production Memory extraction仍为No-Go。
