# ADR-0027：Production Outline Resume Projection Gate

- 状态：Accepted
- 日期：2026-08-07

## 背景

Production composition v1 只覆盖无人工干预的一次性 completed path。虽然 Redis、command 和 checkpoint 的单项集成测试覆盖了 reply，但没有一条版本化证据证明真实 production Worker 会先持久化 interrupt，停止首个 run，再经 reply command、resume outbox 和第二次 claim 从 PostgresSaver 恢复，最终生成与跨语言 workflow expected 相同的文章。

把 cancel、failure、takeover 和 outline resume 同时塞进一个 observation schema，会混合 terminal 与 non-terminal 中间态，并让失败难以定位。

## 决定

1. 将 production composition dataset/target/suite 提升到 v2，并保留 v1 baseline 作为历史证据。
2. v2 增加 `outline-reply-durable-resume`，强引用 workflow shadow 的 `edited-outline-confirm` case。
3. production target 等待 `awaiting_input` 后，使用真实 command repository 提交 fixture reply；production dispatcher 自动发布 resume outbox，Worker 进行第二次 claim。
4. observation 要求两个 completed run、两个 published outbox、`outline_ready → done`、两个 trace identity、一个 revision 0 article，并验证 canonical Markdown 与跨语言 expected 相同。
5. 外层 harness 通过带身份 header 的 durable API 和 Server Component SSR 检查恢复后的主题与编辑大纲；总文章数变为两条生成文章加一条 legacy import。
6. cancel、failure 与 takeover 使用各自可表达 terminal/error/uncertain 状态的 case继续追加，不为迁就单一 completed schema弱化断言。

## 结果与限制

v2 证明真实 pause/resume 跨越数据库、队列、Worker、checkpointer、command/outbox 和 Next read path，但仍不证明浏览器 reply route、SSE 长连接、进程 kill、取消、provider failure 或 lease takeover。生产 provider仍是loopback wire fixture。
