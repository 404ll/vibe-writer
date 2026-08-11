# Eval 0014：Production Composition 联合基线

- 日期：2026-08-07
- Protocol：`production-composition-v1-target-2026-08-07`
- 状态：Passed

## 评测范围

本 Eval 验证真实 PostgreSQL + Redis/BullMQ + production Worker composition 的联合数据流。provider 是 loopback Anthropic protocol fixture，因此结果是 runtime/control-plane E2E，不是 live provider 或文章质量 eval。

## 固定配置

- Worker role：`all`，concurrency 1；
- queue/prefix/worker/database：每次运行使用随机 128-bit harness id隔离；
- business migration：当前 Drizzle migration；
- checkpoint：真实 PostgresSaver；
- model adapter：真实 `AnthropicModel` HTTP mapping，目标为本地协议服务器；
- graph/prompt/tool/code：production composition当前版本快照。

## 结果

| 断言 | 结果 |
|---|---:|
| loopback target + database identity guard | Passed |
| Drizzle migration + PostgresSaver setup | Passed |
| outbox dispatcher → Redis/BullMQ consumer | Passed |
| DB claim/lease + LangGraph execution | Passed |
| Anthropic adapter调用 | 5/5 |
| fenced provider effects | 5/5 succeeded，key符合预期 |
| terminal transaction | 1 article + 1 done + completed job |
| outbox terminal state | published，lock已清理 |
| journal content minimization | article正文未进入 effect rows |
| runtime close + harness cleanup | 幂等 close；PostgreSQL/Redis均停止 |
| full repository verify | Passed；TS/Python/Web/migration/docs无回归 |

## 命令

```bash
pnpm test:worker:production:local
```

该命令需要本机 PostgreSQL binaries 与可用 Docker。测试失败时同样执行清理；PostgreSQL若仍在运行则保留临时目录并明确报错。

## 结论与限制

联合基线消除了“PostgreSQL测试和Redis测试分别通过，但production composition从未整体运行”的证据空白。它仍没有覆盖 Next.js API/SSE、OS级进程信号、kill/crash/network partition、真实 provider、托管环境、认证/tenant或数据迁移，因此不能据此直接切生产流量。
