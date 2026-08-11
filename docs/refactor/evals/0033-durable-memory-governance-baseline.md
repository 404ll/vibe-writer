# Eval 0033：Durable Memory Governance 基线

- 日期：2026-08-07
- 结论：Passed for persistence governance and erasure; extraction and retrieval not evaluated
- 对应迭代：[0037](../iterations/0037-durable-memory-governance-foundation.md)

## Identity

| 项目 | 值 |
|---|---|
| proposal schema | `1` |
| policy | `2026-08-07-v1` |
| migration | `20260807092020_woozy_hellion.sql` |
| persistence | PostgreSQL + Drizzle |
| isolation | workspace predicate + PostgreSQL RLS |
| revision rule | explicit review + compare-and-swap |
| deletion proof | content-free tombstone |

## Governance Matrix

| 场景 | 预期 | 实际 |
|---|---|---|
| eligible completed-run proposal | pending candidate | candidate + proposed event |
| exact extractor replay | same candidate | same id, `created=false` |
| active exact fingerprint | no review noise | duplicate, no candidate |
| active changed fingerprint | no overwrite | conflict candidate |
| conflict without current Memory id | fail closed | rejected transaction |
| explicit conflict replace | append revision | same Memory id, revision + 1 |
| low-confidence/sensitive model inference | no persistence | rejected, zero rows |
| viewer candidate review | forbidden | permission error |
| other workspace review/read | invisible | not found / empty |
| owner hard delete | erase content graph | candidate/event/memory/revision removed |
| retention elapsed | erase content | tombstone only |
| source job/run deletion | propagate erasure | derived current Memory removed |
| non-owner role without workspace setting | zero rows | zero rows across Memory tables |

PGlite 的完整 DB suite 为 14 个文件、91 项；真实 PostgreSQL suite 为 DB 14 项、PostgresSaver 4 项、live sampler 1 项。真实库验证使用临时数据库和非 owner、无 `BYPASSRLS` 角色读取 `memory_candidates`、`memories`、`memory_revisions`、`memory_candidate_events`、`memory_tombstones`。

根级门禁通过 TypeScript 403 项、Python 50 项，共 453 项；component 38/38、workflow shadow 3/3、Web lint/test/build、migration check 和 120 个 Markdown 链接均通过。

## 未证明

- 没有真实 model extractor 的 should-write precision/recall；
- 没有 semantic duplicate、contradiction resolution 或 sensitive classifier quality；
- 没有 expiry scheduler 的持续运行、积压或告警证据；
- 没有 embedding、retrieval recall@k、context precision 或 answer uplift；
- 没有 Memory 管理 API/UI，也没有把 Memory 注入写作 workflow。
