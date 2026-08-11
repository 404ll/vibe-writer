# ADR-0025：版本化 Durable Production Projection Gate

- 状态：Accepted
- 日期：2026-08-07

## 背景

Iteration 0018 已有 PostgreSQL、Redis/BullMQ、Worker、loopback Anthropic adapter 和 Next.js 的联合 E2E，但断言分散在测试里，场景正文与 Iteration 0023 的跨运行时 workflow expected 无关，也没有 suite identity、dataset fingerprint、case inventory 和 tracked metric gate。

在联合 harness 中再启动完整 Python API 并不能证明 durable 语义等价：Python 当前仍使用进程内 job/event store 和 SQLite，没有与目标系统对应的 outbox、lease、effect、trace 和 PostgresSaver。更可靠的迁移证据是使用同一个独立 workflow expected：Python graph 与 TypeScript graph 先分别命中它，TypeScript durable composition 再把它投影到基础设施终态。

## 决定

1. 建立 `production-composition-baseline-v1`，每个 case 通过 `workflow_case_id` 强引用 `workflow-shadow-baseline-v1`；contracts test 要求两者 canonical Markdown 一致。
2. production Eval target 实际启动临时 PostgreSQL、Redis/BullMQ、production Worker、PostgresSaver 和 loopback Anthropic wire server，不使用内存替身代替 queue/database/runtime。
3. normalized observation 固定 job/run terminal、article count/revision/content、event types、outbox status、effect keys、trace operations/trace identity 和 provider request count。
4. `runOfflineEval` 对 observation 与显式 expected 做 canonical exact match，并与 tracked baseline 比较；普通 report 仍不 capture article body。
5. source revision 对 Worker source、production test 和 fixture 计算 SHA-256；baseline 不锁死 source hash。
6. 外层 `run-production-integration.mjs` 继续验证 legacy SQLite dry-run/apply/replay、durable article API 和 Next.js Server Component SSR；它们不塞进单个 Eval score，但必须与 production Eval target 在同一临时环境通过。
7. 该门禁通过 `pnpm test:worker:production:local`（别名 `pnpm eval:production-composition:local`）显式运行，不进入普通 `pnpm verify`。原因是它要求本机 PostgreSQL 工具、Docker 和可用端口，应作为发布/切流门禁而不是每次快速验证的隐式外部依赖。

## 传递式兼容链

```text
explicit workflow expected
  ├─ Python graph observation == expected
  ├─ TypeScript graph observation == expected
  └─ TypeScript durable production projection == expected
       + run/event/outbox/effect/trace invariants
       + Next SSR reads the terminal PostgreSQL article
```

## 不变量

- production fixture 与 workflow fixture 必须是 synthetic 且有稳定版本。
- terminal article 正文不能进入 effect/trace metadata。
- job/run 必须 completed；只能有一个 article revision 0 和一个 trace identity。
- outbox 必须 published；effect/trace 必须全部 succeeded。
- baseline 变化必须显式评审，不能由 harness 自动写回。
- 临时 PostgreSQL 和 Redis 必须带随机 harness identity，结束后确认停止再清理。

## 明确限制

- 联合 harness 内没有启动 Python FastAPI、进程内 SSE store 或 SQLite 写作任务；Python 等价来自同一 expected 的 graph shadow 证据。
- 当前只有一个 happy terminal case，尚未覆盖 durable outline reply、取消、失败、takeover 或多章节并行的 production projection suite。
- loopback provider 验证真实 wire mapping，不证明付费 provider 可用性或文章质量。
- 仍未运行托管 PostgreSQL/Redis、反向代理长连接、真实部署 source migration 或生产流量 shadow。

## 未选择

- 把已有联合测试计数直接当 Eval：缺少 versioned dataset 和 baseline gate。
- 在 root verify 隐式启动 Docker/PostgreSQL：会让快速本地反馈依赖重型外部环境。
- 强行让 Python 生成 durable outbox/effect/trace：这些不是 Python 当前产品事实，会制造伪等价。
- 把文章正文写入 trace/effect 方便比较：违反内容最小化边界。
