# ADR-0012：Postgres Checkpoint Attempt Storage 与 Fenced Pointer

- 状态：Accepted
- 日期：2026-08-07
- Supersedes：ADR-0011 中“顶层 attempt 直接使用非空 `checkpoint_ns`”的实现细节；其 attempt 隔离与 fenced pointer 目标不变

## 背景

Iteration 0010 已让 job/run/event/effect 写入具备真实 PostgreSQL fencing，但 workflow 仍使用 `MemorySaver`。进程重启后无法恢复 outline interrupt、章节 checkpoint 或 pending writes；takeover 后若新旧 Worker 共享同一 checkpoint storage identity，旧 Worker 仍可能污染新 attempt 的恢复点。

LangGraph 的持久化主键是 `thread_id + checkpoint_ns + checkpoint_id`。官方 persistence 契约要求 checkpointer 实现 `put`、`putWrites`、`getTuple` 与 `list`，其中 pending writes 用于恢复 superstep 中已经完成的部分写入。官方 JS PostgresSaver 需要单独安装、首次调用 `setup()`，并支持独立 PostgreSQL schema。参考 [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 与 [PostgresSaver package](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres)。

本仓库实际使用 `@langchain/langgraph 1.4.9`。其顶层 Pregel loop 会把调用方提供的非空 `checkpoint_ns` 重置为 `""`，namespace 由框架用于嵌套 subgraph。因而不能把“每个 run 的顶层隔离”实现为调用方自定义非空 namespace；继续这样做只会得到看似隔离、实际共享的 checkpoint。

PostgresSaver 的表是框架 envelope，不是业务授权表。直接给 graph 一个裸 PostgresSaver 也无法让 `put()` 与 job lease 成为同一个数据库事务；外层需要 attempt-specific storage identity 和 fenced business pointer。

## 决定

1. 每个 run attempt 使用独立物理 `checkpoint_thread_id = job:{job_id}:run:{run_id}`。顶层 `checkpoint_ns` 保持空字符串；未来 subgraph 由 LangGraph 在该物理 thread 下派生 namespace。业务 job id 仍是逻辑 thread，不把物理 attempt thread 暴露成长期 memory/thread 模型。
2. 新增 `checkpoint_attempts` 业务表，保存 job/run、物理 thread、graph version、状态、fork 来源和最新稳定 root checkpoint id。一个 run 只有一个 attempt record，一个 job 同时最多一个 `active` checkpoint attempt。
3. checkpoint attempt 采用 `preparing → active → superseded`：repository 先在有效 lease 下创建 deterministic target；adapter 再把旧 active attempt 的稳定 root checkpoint 和 pending writes复制到新物理 thread；最后 repository 在有效 lease 下原子切换 current pointer。复制成功但激活失败只留下可重试的 preparing/orphan storage，不会改变当前恢复点。
4. 首次 run 没有 fork source，可直接激活空 attempt。takeover 只能从业务表已经提交的 `latest_checkpoint_id` fork；不能扫描 saver 的“最新行”猜恢复点。
5. fork 只允许 source/target `graph_version` 相同。旧 graph checkpoint 必须通过显式 migration 或从头运行，禁止在新 graph/prompt/tool 配置下静默恢复。
6. 新增 infrastructure package `@vibe-writer/checkpoint-runtime`。`workflow-runtime` 继续只依赖 `BaseCheckpointSaver`，不得导入 PostgreSQL、Drizzle 或 PostgresSaver。
7. `FencedCheckpointSaver` 包装官方 PostgresSaver。所有配置强制使用当前 attempt 的物理 thread id；调用方不能越权读写其他 attempt。`put`/`putWrites` 前后都验证 active lease/attempt；root `put` 先写 saver，再 fenced 更新业务 pointer。若 lease 在 saver write 后丢失，旧数据只落在旧物理 thread，pointer 更新失败并向 graph 抛出 `checkpoint_lease_lost`。
8. wrapper 允许 LangGraph 管理当前物理 thread 下的 subgraph namespace，但只把 root namespace `""` 的 checkpoint id推进为业务恢复 pointer。subgraph checkpoint 不覆盖 root pointer。
9. fork 复制 checkpoint、metadata 和按 task id 分组的 pending writes；metadata 标记 `source: "fork"` 并保留来源。`previously copied` 必须幂等，同一 target/source 重试不能产生另一条 current attempt。
10. 官方 saver 表放在独立 `langgraph_checkpoint` schema。`setup()` 只在部署/migration 或显式测试启动执行，不在每个 job 热路径自动建表；应用业务 migration 仍由 Drizzle 管理。
11. wrapper 在序列化前执行应用级 payload 上限：单个 channel 与 checkpoint 总 JSON 大小都必须有界。完整 prompt/transcript/provider payload 不进入 state；PostgreSQL at-rest encryption、备份与 TLS 属于部署门槛，不能由本迭代的本地数据库测试代替。
12. 删除只能以物理 attempt thread 为单位，并由后续 retention/reconciler 在非 active attempt 上执行。生产 API 不暴露裸 `deleteThread(jobId)`；memory/thread 删除与 checkpoint retention 是两套策略。
13. 本迭代验证真实 PostgresSaver 的 `setup`、put/get/list、outline interrupt/resume、章节/terminal replay、pending writes fork、takeover isolation、stale pointer rejection、schema 与 payload guard。只有 MemorySaver 或 mock saver 证据不算退出。

## 不变量

- 一个 job 同时最多一个 active checkpoint attempt；
- active attempt 必须属于 job 当前 running run 与 lease token；
- 旧 attempt 的 saver write 永远不能改变新 attempt 的业务 pointer；
- 恢复来源只来自 fenced `latest_checkpoint_id`，不从框架表猜测；
- 不兼容 graph version 不静默 fork；
- root 与 subgraph checkpoint namespace 不混为一个 pointer；
- checkpoint persistence 不等于 long-term memory。

## 结果

- 进程重启和 takeover 可以恢复 durable workflow state，同时把 zombie 写入限制在旧物理 thread；
- LangGraph envelope 继续由官方 saver 管理，业务授权、lineage 和 retention 由本仓库 schema 管理；
- 需要接受 saver write 与 fenced pointer 不是原子事务：协议通过 write-first/pointer-second 和 attempt isolation 把 crash window 收敛为可重试 orphan，而不是 exactly-once。

## 未选择

- 顶层直接使用非空 `checkpoint_ns`：当前 LangGraph.js 会重置它，不能形成真实隔离；
- 所有 attempt 共用 job id 作为 saver `thread_id`：zombie Worker 会写进新 attempt 的恢复链；
- fork 时只复制 channel values：会丢失 envelope、versions_seen、metadata 和 pending writes；
- 直接修改官方 saver 表增加 lease token：耦合上游 migration，升级与 conformance 风险不可控；
- 把 checkpoint 当 memory：execution state 的生命周期、隐私和检索语义与长期 memory 不同。
