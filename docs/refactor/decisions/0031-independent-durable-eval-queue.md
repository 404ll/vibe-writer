# ADR-0031：Independent Durable Eval Queue

- 状态：Accepted
- 日期：2026-08-07

## 背景

已有 component/workflow/production Eval 可以同步运行并持久化报告，但还没有可独立扩缩容的执行平面。若直接把 case、expected 或模型输出塞进 Redis，队列会成为第二份敏感数据源；若只依赖 BullMQ job 状态，又无法在 Redis 丢失、重复投递或 Worker takeover 后解释 Eval run 的真实状态。

写作任务与 Eval 的并发、成本和失败策略也不同，不能让回归实验占用用户任务的 consumer。

## 决定

1. PostgreSQL 持有 queued Eval request、不可变 suite/dataset/target/execution identity、attempt、lease 和最终 trial/score；Redis/BullMQ 只投递版本化 `{evalRunId}` 指针。
2. `enqueueRun()` 在一个事务中幂等创建 `eval_runs(mode=queued,status=queued)` 与 `eval.run.requested` outbox。CLI 的 `enqueue` 只登记请求，不预先执行 suite。
3. Eval 使用独立 queue name、publisher、dispatcher、consumer 和进程入口；配置拒绝复用默认 write queue name。
4. write/Eval dispatcher 按 `aggregate_type` 领取 outbox，互不窃取事件。queue job id 从 Eval run UUID 稳定派生，允许重复 publish。
5. Worker 以数据库时间 claim/heartbeat；过期 lease 可 takeover 并增加 attempt。所有 heartbeat、失败和 report commit 都由 lease token fencing。
6. report identity 必须与 queued request 完全一致；所有 trial/score 与 terminal run 更新在同一个事务提交。过期 token 不能写入部分报告。
7. executable target 通过显式 registry 解析。首个 registry 只接受当前 synthetic component suite；dataset fingerprint 与 execution snapshot 不匹配时 fail closed。
8. queue payload 上限为 1 KiB，payload schema 多字段、未知版本或非 UUID 均不可恢复；busy/lease-lost delivery 才由 BullMQ 重试。

## 结果与限制

该边界允许 Eval 与用户写作独立扩缩容，也让未来 live sampler、grader 和 memory Eval 复用 durable request/lease/report 协议。Redis 丢失时 PostgreSQL 中的 queued request/outbox 仍是恢复依据。

当前只注册 deterministic component target，没有 live trace sampler、真实模型 grader、用户内容 ingest、Eval cancel/reconciler、CI artifact retention 或跨 region fault test。`user_content` suite 在 workspace/RLS、consent 与 retention 接通前不得进入该 worker。
