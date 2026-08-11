# Eval 0020：Durable Production Projection 基线

- 日期：2026-08-07
- 结论：Passed for synthetic durable production projection
- 对应迭代：[0024](../iterations/0024-durable-production-projection-gate.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `production-composition-regression@2026-08-07-v1` |
| dataset | `production-composition-baseline-v1` |
| dataset fingerprint | `sha256:f508f9f098625cd2700daedacc60a42d60c3a5587195cdc03c7c35ced3e9fe71` |
| workflow source case | `workflow-shadow-baseline-v1/happy-no-intervention` |
| target | `typescript-durable-production-composition@v1` |
| evaluator | `canonical-production-projection@v1` |
| metric | `durable_projection_exact_match` |
| model profile | `loopback:anthropic-wire-v1` |
| graph | `writer-graph-v1-target-2026-08-07` |
| code revision | Worker source、production test 与 fixture 的运行时 SHA-256 |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| unique cases | 1 | 1 | Passed |
| target errors | 0 | 0 | Passed |
| evaluator errors | 0 | 0 | Passed |
| durable projection scores | 1 | 1 | Passed |
| pass rate | 1.0 | 1.0 | Passed |

## 联合环境证据

- 临时 PostgreSQL 使用随机 database name 和 harness comment；
- Redis 7.4 Docker 使用随机 container/queue/prefix；
- BullMQ outbox delivery 进入 production `role=all` Worker；
- Worker 通过真实 Anthropic Messages wire adapter 调 loopback provider；
- PostgresSaver、lease/fencing、terminal transaction 生成 1 条 revision 0 article 和 1 个 `done` event；
- 5 个 effect 与 5 个 trace span 全部 succeeded，正文不在 metadata；
- legacy SQLite dry-run/apply/replay仍通过；
- Next durable build、readiness、article API 和 Server Component SSR 读取同一 PostgreSQL；
- Redis/PostgreSQL/Next 结束后均停止，临时数据清理。

根级快速门禁另通过 TypeScript 337 项、Python 50 项，共 387 项测试；Web lint/build、全部 typecheck、migration check、38-case component gate、3-case workflow shadow gate和 81 个 Markdown 文件链接检查均通过。

## 命令

```text
pnpm test:contracts
pnpm typecheck:contracts
pnpm typecheck:worker
pnpm test:worker:production:local
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
pnpm check:docs
git diff --check
```

## 未证明

- 没有在联合 harness 启动 Python FastAPI；跨语言兼容由同一 workflow expected 的两级 gate传递证明；
- 没有 production outline reply、cancel、failure、takeover 或多章节 case；
- 没有真实 Anthropic/Tavily、文章质量、live traffic、托管数据库或网络分区；
- 没有 auth/RLS、实际 source migration、Memory 或 CI artifact retention。

## 结论

同一个 synthetic workflow expected 已从 Python/TypeScript graph 延伸到 TypeScript durable production composition 和 Next SSR。该结果显著增强切流证据，但不能替代剩余异常路径、live eval、身份隔离和真实部署迁移门禁。
