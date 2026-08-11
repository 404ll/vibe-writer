# Eval 0007：Postgres Checkpoint Attempt 基线

- 日期：2026-08-07
- Protocol：`checkpoint-attempt-v1-target-2026-08-07`
- Graph：`@langchain/langgraph 1.4.9`
- Checkpointer：`@langchain/langgraph-checkpoint-postgres 1.0.4`
- 状态：Passed（本地 PostgreSQL 基线）

## 评测范围

本 Eval 验证 PostgresSaver envelope、attempt storage isolation、fenced business pointer、fork/pending writes 和真实 workflow resume。它不运行 BullMQ、真实模型/provider、生产 API 或文章质量评测。

覆盖：

- saver setup/schema/put/get/list；
- prepare/fork/activate/advance 状态机；
- lock/lease takeover 与 zombie writes；
- outline interrupt/resume；
- chapter/terminal checkpoint replay；
- pending writes fork；
- graph version、payload、scope 与 retention guard；
- migration、package architecture 与全仓验证。

## 当前结果

2026-08-07 在 harness 创建并标记的临时 PostgreSQL 14.20 cluster 上运行：

| 层级 | 结果 | 关键证据 |
|---|---:|---|
| DB repository/PGlite | 30/30 | prepare/activate 幂等、root pointer、takeover、graph version |
| checkpoint runtime/unit | 8/8 | scope、payload、subgraph、write 后丢 lease、fork/pending writes |
| real PostgreSQL DB | 5/5 | 双 session claim/takeover、event/effect fencing |
| real PostgresSaver | 4/4 | setup/schema、takeover、interrupt resume、terminal/chapter replay |

真实 PostgresSaver suite 证明：

- `setup()` 在 `langgraph_checkpoint` 建立 `checkpoint_migrations`、`checkpoints`、`checkpoint_blobs`、`checkpoint_writes`；
- takeover 把 fenced root checkpoint 与 pending writes 复制到新的 per-run 物理 thread；旧 token 的 `put` 和 `putWrites` 都被拒绝，当前 attempt pointer 不变；
- outline interrupt 后关闭并重建 saver/graph，仍能确认并完成，Planner 不重复执行；
- 完成态 checkpoint replay 不重复组件；从第二章 coverage 前的 checkpoint replay 只重做第二章，不重复第一章；
- destructive test 只接受 harness 随机数据库名、loopback server address 和 database comment；结束后 PostgreSQL 服务停止，临时 cluster 清理。

MemorySaver 的 Eval 0004 和 fenced-effect 的 Eval 0006 仍只作为前置基线；本 Eval 才是当前 PostgresSaver envelope 与恢复协议的证据。

## 运行命令

```bash
pnpm --filter @vibe-writer/db test
pnpm --filter @vibe-writer/checkpoint-runtime test
pnpm test:db:postgres:local
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
```

全仓 verify 通过：contracts 19、model runtime 9、agent core 92、workflow runtime 47、DB 30、checkpoint runtime 8、Worker 10、Python API 50、Web 12；migration check、Web lint/build 与 40 个 Markdown 文件链接检查通过。Python 依赖产生既有 deprecation warnings，不影响本次结果。

## 不代表什么

- 本机 PostgreSQL 不代表托管 PostgreSQL、连接池代理或网络分区；
- durable checkpoint 不让外部 provider side effect 获得 exactly-once；
- checkpoint 不等于长期 memory、RAG、trace 或 eval dataset；
- 本 Eval 不证明 BullMQ retry、Next API 切流或 Python retirement。
