# Eval 0005：Worker Lease 故障基线

- 日期：2026-08-07
- Protocol：`worker-lease-v1-target-2026-08-07`
- Database：PostgreSQL semantics via PGlite
- Worker：scripted executor
- Drizzle ORM：`0.45.2`
- PGlite：`0.5.4`

## 评测范围

本 Eval 验证 claim/heartbeat/cancel/settle 的确定性状态机与 fencing 行为。它不比较文章质量，也不把 PGlite 当作真实 PostgreSQL/BullMQ/PostgresSaver 的替代品。

计划覆盖：

- duplicate claim；
- active lease rejection；
- expired lease takeover；
- stale heartbeat/settle rejection；
- cancellation observation；
- terminal idempotency；
- Worker heartbeat/AbortSignal/exception orchestration。

## 当前结果

- DB：1 个文件、16 项 migration/repository 集成测试通过，其中包含 populated v1→v2 forward migration；
- Worker：2 个文件、10 项 runner/boundary 测试通过；
- 已覆盖 claim 对空/`prototype-unbound` execution metadata 的拒绝、single-client PGlite + `Promise.all` duplicate claim、DB-time heartbeat、expired takeover、stale/expired token、cancel observation、completion/cancel race、terminal idempotency、sanitized failure 和 lease-lost abort；
- DB/Worker 窄测试、双方 typecheck、Drizzle migration check、全仓 verify 和 `git diff --check` 通过；
- 架构、代码与 Eval 三类独立读者 closure 通过。初审发现的 populated forward migration、取消迁移、heartbeat shape、并发证据过度声明和未 fenced 副作用边界均已修正或明确留入 R5。

## 运行 provenance

- Git base revision：`c47cbfd0ab1f05630f189c9aecfe0ab8ec50033f`
- Worktree：dirty，最终验证前共有 53 个 tracked/untracked 状态项；本轮没有 commit，因此 base revision 不能独立恢复这份 patch
- Node.js：`v22.14.0`
- pnpm：`10.0.0`
- Python：`3.14.5`
- TypeScript：`6.0.3`
- Vitest：`4.1.9`

相关 artifact SHA-256：

| Artifact | SHA-256 |
|---|---|
| `packages/db/src/schema.ts` | `b7cd1c642360627948b439318ee8c26bbb765c79fd337c082857c0f2e2e1dea2` |
| `packages/db/src/domain.ts` | `505067bd7226c3bab37e8df8e0bacf546ea863d004e0aa055485b82a9e131baf` |
| `packages/db/src/repositories/jobs.ts` | `94b101879a8b83bfdc1793a3d2a66a9bfa857eb5eb4f8ea787e32b7e8e0820a5` |
| `packages/db/drizzle/20260806204512_awesome_vengeance.sql` | `3ce698646bc5b3b9b6ea5eae86fd56d9c5f198ca2941678644c18d0db616922a` |
| `packages/db/drizzle/meta/20260806204512_snapshot.json` | `f00a418246f2cecd1e355c2717c45c336e4448622b6bc30b353f10054a643f90` |
| `packages/db/tests/jobs.integration.test.ts` | `1d573f3a61ba70ed7b6111491549d4b7285a2ee3db506bc4a6b5df58441a7604` |
| `apps/worker/src/runner.ts` | `ccbffa4f8b3c9c43b2f2a4218cacb0bf9ec1a797012dffb685c7bd2ac3cb9d6e` |
| `apps/worker/src/index.ts` | `bf8d34bf98c18e69a58af35fe11e80501e1b930e8a73d5ebbc719632f2ca5ead` |
| `apps/worker/tests/runner.test.ts` | `8f45e103c80cefdd144ff8c6608f5c850ed939bbb323a576619d0c743a9f6242` |
| `apps/worker/tests/architecture.test.ts` | `b4b74e9517095e8c31ec76869ece09d6137a134037aebee39f12004d78b7c78c` |
| `apps/worker/package.json` | `4de07a88e6fec3779300a7c6398f509b11bbde20b968bac4e9c03d0dedb20049` |
| `package.json` | `e022a874e76155b68906b41c656b4d2aca49839fc3316cb481b27a3b10289114` |
| `pnpm-lock.yaml` | `bc8d151d62773d6dade80ec578a3943074c25d49cbf6d0f08237d13c983e7f3f` |

最终命令：

```bash
API_PYTHON=/absolute/path/to/.venv/bin/python pnpm verify
git diff --check
```

两条命令均以 0 退出。全仓最终结果：contracts 19、model-runtime 9、agent-core 92、workflow-runtime 47、DB 16、Worker 10、Python API 50、Web 12；相关 TypeScript typecheck、Drizzle migration check、Web lint、Next.js production build和 34 份 Markdown relative-link check 全部通过。Python 仍产生 2572 条既有 asyncio/FastAPI/`utcnow()` deprecation warning。

### 可复现性边界

当前 worktree 未提交，artifact hash 只能核对当前 checkout，不能从 Git 独立取回这份 patch。真正可独立重建的 code revision 必须是后续用户授权提交后的 commit SHA；真实 PostgreSQL、Redis/BullMQ 与 provider 环境也尚未形成可复现的 integration fixture。

## 不代表什么

- 尚未验证真实多连接 PostgreSQL 的锁等待、隔离级别和网络故障；
- 尚未验证 BullMQ stalled job/retry 与数据库 claim 的组合；
- 尚未验证 PostgresSaver、进程 kill 后 graph resume 或 checkpoint migration；
- 尚未运行真实模型、工具或 export 副作用。
- 当前 `appendEvent()`、checkpoint、article/export 与 tool-call journal 未接 lease identity；本 Eval 不能外推为这些副作用已 fenced。

后续状态：Eval 0006 已覆盖真实 PostgreSQL 多连接以及 fenced run event/effect journal；本记录保留为 Iteration 0009 当时的 PGlite 基线。Terminal transaction 与 PostgresSaver 仍未覆盖。
