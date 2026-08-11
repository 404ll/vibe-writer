# ADR-0030：Production Expired-Lease Takeover Projection Gate

- 状态：Accepted
- 日期：2026-08-07

## 背景

Repository 与 queue 单项测试已覆盖 lease expiry，但 production projection 没有证明一个已 reserve 外部 effect 的旧 attempt 过期后，真实 Worker 能否安全接管，也没有证明旧 token 在新 attempt 完成后无法补写 effect 或覆盖 terminal。

单纯断言“第二个 Worker 完成”不够。takeover 必须同时解释旧 run、未决 effect/trace、稳定 effect key、领域重试与旧 token fencing。

## 决定

1. 建立独立的 `production-takeover-baseline-v1` dataset、target、suite、observation schema 和 tracked baseline，并连接 workflow shadow 的 `happy-no-intervention` expected。
2. 测试先由 stale Worker claim job，并 reserve 真实 workflow 将使用的 `model:plan:attempt:1` effect/trace；随后显式让 lease 过期，再启动 production Worker/dispatcher/consumer。
3. takeover transaction 必须把旧 run 标记为 `lease_expired/failed`，把旧 effect/trace 标记为 `lease_takeover/uncertain`，并创建 attempt 2 与新的 trace id。
4. 新 attempt 遇到相同 effect key 的 uncertain 记录时 fail closed，不重复调用 provider；workflow component policy 使用新的 `plan:attempt:2` 做一次有界恢复，然后完成文章。
5. 旧 lease token 在新 attempt 完成后调用 effect finish 与 terminal settle 都必须返回 `lease_lost`。
6. observation 使用状态计数表达 5 个 succeeded + 1 个 uncertain effect/trace，避免依赖 effect key 排序；文章正文仍命中共享 workflow expected。

## 结果与限制

该 gate 证明 lease takeover、uncertain effect、领域重试、最终文章和 stale-token fencing 能在真实 PostgreSQL、Redis/BullMQ 与 production Worker 中闭环。

测试通过数据库时间制造过期，不会真的 kill 进程；它仍不证明 OS crash、network partition、BullMQ stalled redelivery、provider 端结果查询或 uncertain resolver。旧 effect 是否已在外部成功仍未知，因此不能自动用同 key 重放。
