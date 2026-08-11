# Eval 0009：Durable Terminal 基线

- 日期：2026-08-07
- Protocol：`durable-terminal-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

验证 terminal checkpoint、article、job/run terminal 与 SSE terminal event 的原子性、幂等和 takeover fencing。它不运行真实模型，也不证明 Next.js API 已切流。

## 计划覆盖

- completed/failed/cancelled terminal transaction；
- article fingerprint/idempotency collision；
- event seq 与 terminal uniqueness；
- lease expiry/takeover zombie commit；
- terminal checkpoint replay 不重复 component；
- BullMQ duplicate delivery 与 crash window；
- output_path nullable compatibility。

## 结果

| 层级 | 结果 | 证明范围 |
|---|---:|---|
| Contracts | 20/20 | `done.output_path` 同时接受 Python string 与 TS null |
| DB/PGlite | 40/40 | article/done 原子提交、failed/cancelled event、awaiting-input、seq、collision、stale/takeover |
| Worker/PGlite | 33/33 | 显式 executor result、terminal routing、interrupt、terminal-checkpoint crash replay |
| Real PostgreSQL | 7/7 + 4/4 | 多 session terminal winner/replay、DB-time fencing、真实 PostgresSaver |
| Real Redis/BullMQ | 7/7 | duplicate/stalled/cancel/outbox/shutdown 与唯一 article/event |
| Full verify | Passed | TS/Python/Web/migration/docs 全链路 |

crash-window 用例先让第一任 run 完成 graph 并持久化 terminal checkpoint，但不提交 article；随后令 lease 过期，由第二任 run takeover、fork checkpoint 并 replay。最终 Planner/Writer 调用次数仍各为 1，数据库只有 1 个 article 和 1 个 done event，两个 run 状态为 `failed → completed`。

## 结论与限制

本基线证明 scripted workflow + durable infrastructure 的终态原子性和恢复语义；它不证明真实 provider 调用可 exactly-once，也不证明 Next.js API/SSE 已切流。`awaiting_input` 的 resume command 持久化、对象存储 artifact、托管 PostgreSQL/Redis 与进程 kill/network partition 仍需后续 eval。
