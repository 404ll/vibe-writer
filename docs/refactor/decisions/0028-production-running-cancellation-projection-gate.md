# ADR-0028：Production Running Cancellation Projection Gate

- 状态：Accepted
- 日期：2026-08-07

## 背景

已有 BullMQ 单项测试证明 heartbeat 可以观察取消请求，但 production projection 只覆盖 completed 与 outline resume。它没有证明真实 provider 请求已经发出后，Worker 会中止调用、用当前 lease 收敛 job/run、发布 terminal event，并且不留下文章、reserved effect 或 running trace。

取消、失败和 lease takeover 的合法终态不同。把它们塞进 completed-only observation 会迫使 schema 放宽，反而掩盖异常路径回归。

## 决定

1. 建立独立的 `production-cancellation-baseline-v1` dataset、target、suite、observation schema 和 tracked baseline，不提升或复用 production composition v2。
2. case 必须等待 loopback Anthropic server 已收到请求且 job 已为 running，再写入 `cancel_requested_at`；阻塞 server 不主动响应，只有 Worker 的 `AbortSignal` 能结束调用。
3. observation 固定 cancelled job/run、零 article、cancelled event、published outbox、一次 provider request，以及未完成 effect/trace 的 uncertain 状态。
4. `TerminalRepository.terminateClaim()` 必须在同一个 fenced transaction 中把 reserved effect 和 running trace 都收敛为 uncertain，再提交 run/job terminal 与事件；terminal run 下面不允许保留 running span。
5. effect/trace 仍只保存 bounded metadata，测试显式检查 topic 不进入两者。
6. failure 与 takeover 继续使用独立 schema 和 baseline，避免把 cancellation 的 expected 当成所有异常路径的共同模型。

## 结果与限制

该 gate 证明了数据库轮询取消、provider abort、terminal transaction、outbox 和 bounded trace 在 production composition 内闭环，并发现、修复了 TerminalRepository 遗漏 running trace 收敛的问题。

它仍不证明 HTTP cancel route、浏览器 SSE、跨 workspace cancel 负例、真实 provider/network partition、进程强杀或 lease takeover。`uncertain` 表示外部请求已发出但本地无法证明其最终副作用，不应自动重试。
