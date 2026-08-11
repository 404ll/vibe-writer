# Eval 0011：Durable Article Revision 基线

- 日期：2026-08-07
- Protocol：`durable-article-revision-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

验证 PostgreSQL article read/write model、revision 乐观并发、不可变历史快照和默认关闭的 Next.js article staging API。它不运行真实模型，不迁移 SQLite，也不代表浏览器或生产流量已经切到 Node API。

## 计划覆盖

- terminal article list/detail projection；
- PATCH old-current snapshot + revision bump；
- restore pre-restore-current snapshot；
- stale writer/missing version 无副作用；
- PGlite 与真实 PostgreSQL multi-session single winner；
- durable route contract、precondition、409/current revision 和 disabled flag；
- full verify、Next build routes、migration/docs/diff check。

## 结果

| 层级 | 结果 | 证明范围 |
|---|---:|---|
| Contracts | 20/20 | Python fixture 兼容、revision-aware TS wire schema |
| DB/PGlite | 47/47（其中 article 3） | projection、PATCH/restore snapshot、stale/missing 无副作用 |
| Real PostgreSQL | 9/9 + 4/4 | 两个 backend session 同 revision single winner；PostgresSaver 无回归 |
| Web | 22/22 | fail-closed、article projection、428 precondition、409/current revision、mutation response |
| Full verify | Passed | TS/Python/Web/migration/docs 全链路 |

真实 PostgreSQL 用例从 terminal transaction 创建 revision 0 article，再由两个独立连接同时 PATCH `expectedRevision: 0`。结果恰好为一个 `updated`、一个 `revision_conflict`，current revision 为 1，version 数为 1。

restore 的 PGlite 用例先 PATCH 到 revision 1，再恢复 revision 0 快照；恢复事务创建 source revision 1 的快照并把 current 提升到 revision 2，因此恢复前编辑稿仍可找回。

## 结论与限制

本基线证明当前 scripted terminal article 的 PostgreSQL 读写面具备 revision 防覆盖和可撤销 restore 语义；它不证明认证/tenant 隔离、SQLite backfill、真实 provider、部署拓扑和浏览器切流已经完成。
