# Iteration 0010：真实 PostgreSQL 与 Fenced Effects

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R5 Worker cutover
- 对应决策：[ADR-0010](../decisions/0010-worker-lease-and-fencing-protocol.md)、[ADR-0011](../decisions/0011-fenced-effects-and-checkpoint-attempt-isolation.md)

## 目标

把 Iteration 0009 的 PGlite 控制面协议放到真实 PostgreSQL 独立连接下验证，并建立第一批不可被 zombie Worker 绕过的副作用边界：幂等、连续的 run progress event，以及显式表达 crash uncertainty 的 effect journal。

## 范围内

- 只对 harness 标记的一次性 loopback database 开放 destructive setup、也可由本机临时 PostgreSQL cluster 运行的集成测试基座；
- 两个独立 PostgreSQL backend session 的 duplicate claim、row-lock/recheck、lease expiry takeover 与 stale token 回归；
- `job_events` 的 job-scoped idempotency key、payload fingerprint、forward migration；
- fenced `appendRunEvent()`：active lease/run 校验、重复重放、collision、连续 seq；
- `run_effects` journal 与 reserve/complete/fail/uncertain 状态机；
- takeover 对旧 reserved effect 的 uncertainty 收敛；
- PGlite 与真实 PostgreSQL repository tests、ADR、系统设计、Iteration 和 Eval。

## 范围外

- 不接 BullMQ/Redis consumer、provider SDK 或真实付费调用；
- 不接 PostgresSaver，不实现 checkpoint namespace fork/pointer；
- 不实现 terminal event + settle/article 的最终 transaction；
- 不实现 article/version schema、export adapter 或 tool-specific resolver；
- 不切换 Next.js API、FastAPI/Python 或生产数据库；
- 不宣称外部副作用 exactly-once、进程 kill、网络分区或托管 PostgreSQL 已验证。

## 必须证明的行为

1. 两个不同 PostgreSQL backend session 竞争同一 queued job 时只有一个 claim/run；
2. 第二个 session 在 row lock 后以 READ COMMITTED 重新检查条件，不创建重复 attempt；
3. lease 过期后新 session 创建 attempt 2，旧 token 的 heartbeat、settle、event 和 effect completion 都失败；
4. 写事务在 lease 有效时开始、等待 job row lock 并跨过 expiry 后，必须按当前数据库 wall clock 返回 `lease_lost`；
5. 同 event key/同 run/同 payload 重放返回原 event，不增加 seq；
6. 同 event key 跨 attempt 的相同 payload 重放已有 event，不同 payload 被拒绝，两个并发 event 获得连续唯一 seq；
7. terminal event 不能走 progress-event API；
8. effect 首次 reserve、同 run 重放、previously-succeeded/failed、fingerprint collision 都有确定语义；
9. takeover 将旧 reserved effect 标为 uncertain，新 attempt 不会默认重复执行；
10. PGlite 快速测试与真实 PostgreSQL integration 都通过，migration/snapshot 无漂移；
11. 未实现的 terminal transaction、PostgresSaver、provider idempotency 和 resolver 明确进入 Eval 0006。

## 当前状态

已实现：

- `job_events` 增加非空 job-scoped idempotency key、payload fingerprint 与唯一索引；populated v2→v4 migration 会先安全回填旧 event；
- generic optional-run `appendEvent()` 被 fenced `appendRunEvent()` 取代；active lease/run 在 job row lock 内校验，terminal event 被明确拒绝；
- 同 key/同 payload在相同或新 attempt 返回原 event，不消耗 seq；同 key/不同 payload报 collision；
- `run_effects` 记录 model/tool/search/export 的 canonical request fingerprint、owner run、bounded metadata 与 reserved/succeeded/failed/uncertain；
- claim takeover 和 run terminal settlement 会把遗留 reservation 标为 uncertain；旧 token 无法 append event 或 finish effect；
- 共享 `fingerprintEffectRequest()` 只接受 typed canonical JSON，并在运行时拒绝 `undefined`、非有限数字、Date/Map/Set、非 plain object、稀疏数组和循环引用，再生成 SHA-256；repository 也拒绝调用方自定义的非标准 fingerprint；
- lease 判断已从 transaction timestamp `now()` 改成 wall-clock `clock_timestamp()`；event/effect 在取得 job row lock 后重检 expiry，并新增“等待跨过 expiry”的双连接回归；
- 同一次 claim/heartbeat/settle 通过事务内 SQL 子查询把 `jobs` 原始 timestamp 直接镜像到 run/effect，避免多条 SQL 分别求值 `clock_timestamp()`，也避免时间经过 JS `Date` 丢失 PostgreSQL 微秒；PGlite 回归会在数据库内比较 job/run 的 expiry、heartbeat 与 finished timestamp；
- `scripts/run-postgres-integration.mjs` 在临时目录初始化 PostgreSQL，通过动态 loopback port 运行；测试在 migration/TRUNCATE 前校验随机数据库名、loopback 地址与 harness 写入的 database comment。cleanup 先确认 server 已停止再删除 cluster；停止失败时保留目录用于恢复，不会删除运行中实例的数据目录；
- 最新代码的 PGlite 2 个文件、26 项 migration/repository/architecture 测试、DB typecheck、migration check 与 `git diff --check` 已通过；全仓 `pnpm verify` 也通过（contracts 19、model-runtime 9、agent-core 92、workflow-runtime 47、DB 26、Worker 10、Python API 50、Web 12、Next.js build、37 份文档链接）；架构、代码与证据 reader 最终均无残留 P1/P2；PostgreSQL 14.20 一次性本地 cluster 的 1 个文件、5 项 multi-session integration 全部通过，包含锁等待跨过 lease expiry 的回归，server 随后正常停止并清理。

首次收口复跑时，安全 guard 在 destructive setup 前正确拒绝了 PostgreSQL 14 返回的 `127.0.0.1/32` 地址文本；guard 改用 `host(inet_server_addr())` 后再次运行，5 项全部通过。这一失败与修复保留在记录中，避免后续 CI/版本差异被误判为业务测试失败。

## 回滚

当前 Python 路径不读取这些表/字段。若 migration 尚未进入共享数据库，可移除本轮 schema/repository/test；若已应用，新增 forward compensating migration 删除新索引/字段/表，不修改已有 migration history。
