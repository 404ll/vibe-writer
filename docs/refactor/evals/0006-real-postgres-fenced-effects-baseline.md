# Eval 0006：真实 PostgreSQL 与 Fenced Effects 基线

- 日期：2026-08-07
- Protocol：`fenced-effects-v1-target-2026-08-07`
- Database：real PostgreSQL + PGlite regression
- Worker：repository/scripted boundary
- PostgreSQL：`14.20`（Homebrew local ephemeral cluster）
- PGlite：`0.5.4`

## 评测范围

本 Eval 验证独立 PostgreSQL session 的 claim/takeover，以及 run event/effect journal 的 fencing、幂等和 uncertainty 语义。它不运行真实 provider、BullMQ 或 PostgresSaver，也不评价文章质量。

计划覆盖：

- deterministic multi-session duplicate claim；
- expired takeover 与 stale write rejection；
- event replay/collision/sequence；
- effect reserve/replay/complete/fail/uncertain；
- populated forward migration；
- package architecture boundary。

## 当前结果

- PGlite：最新代码 2 个文件、26 项 migration/repository/architecture 测试通过；
- 真实 PostgreSQL：最新代码 1 个文件、5 项 multi-session integration 测试全部通过；独立 reader 发现的 transaction `now()` 锁等待问题已由 `clock_timestamp()` 与锁后重检修复，新用例证明等待跨过 lease expiry 后 effect completion 返回 `lease_lost`；
- duplicate claim 测试确认两个不同 `pg_backend_pid()`，通过 trigger 在持有 queued→running row lock 时 `pg_sleep(0.20)`，第二个 session 等待并在提交后重新检查 predicate；最终只有一个 run、job version 只增加一次；
- event 测试覆盖跨 session 同 key replay、6 个并发唯一 event 的连续 seq、跨 attempt replay、payload collision、terminal rejection 与 stale token rejection；
- effect 快速测试覆盖严格 canonical JSON fingerprint、single-winner reservation、complete/fail/replay、takeover/terminal uncertainty 和 stale completion rejection；非 JSON 类型、稀疏数组与循环引用会在 fingerprint 前被拒绝；
- populated v1→v2 与 v2→v4 forward migration、Drizzle migration check、DB typecheck 和 schema generate no-drift 通过；
- local harness 使用临时目录、动态 loopback port、trust-only ephemeral cluster，并在 migration/TRUNCATE 前核对随机 database name、loopback 地址和 harness comment；cleanup 只在确认 PostgreSQL 已停止后删除目录。PostgreSQL 14.20 成功运行后 server 正常停止并清理。

本轮全仓命令：

```bash
API_PYTHON=/absolute/path/to/.venv/bin/python pnpm verify
git diff --check
```

两条命令均以 0 退出。全仓结果为 contracts 19、model-runtime 9、agent-core 92、workflow-runtime 47、DB 26、Worker 10、Python API 50、Web 12；相关 TypeScript typecheck、Drizzle migration check、Web lint、Next.js production build 和 37 份 Markdown relative-link check 全部通过。Python 仍产生 2572 条旧运行时 deprecation warning。

真实 PostgreSQL 退出命令：

```bash
pnpm test:db:postgres:local
```

命令以 0 退出：1 个文件、5 项测试通过。首次运行在 destructive setup 前因 PostgreSQL 14 将 loopback 输出为 `127.0.0.1/32` 而被 guard 拒绝；改用 `host(inet_server_addr())` 后复跑通过，证明 guard fail-closed 且兼容实际地址格式。

## 当前 artifact provenance

- Base commit：`c47cbfd0ab1f05630f189c9aecfe0ab8ec50033f`
- Worktree：未提交，`git status --short` 当前 53 项；hash 只能核对当前 checkout，不能替代可取回的 commit
- Runtime：Node `22.14.0`、pnpm `10.0.0`、Python `3.14.5`、PostgreSQL binaries `14.20`

| Artifact | SHA-256 |
|---|---|
| `packages/db/src/domain.ts` | `d904b6f6a161c6dc686948fa407f946c92513665862a708e7644716d7fd3cee0` |
| `packages/db/src/schema.ts` | `472f704c072461b9be46380b33e76d8a16cb35a0e3ba7407d976b12c40ac215b` |
| `packages/db/src/repositories/jobs.ts` | `2395f4fc08a8748cf2d4e251c96ed89fd25a3c80151334f6e09d2b11727099b9` |
| `packages/db/drizzle/20260806211333_cold_daredevil.sql` | `d84f675ad5b111b2d0b8fe7661a95025fec654566e98c00d9770f59cdf0ce65e` |
| `packages/db/drizzle/20260806212115_tough_captain_midlands.sql` | `db54bc89157bde34720c3e57e6d01213d575e777feb5c15b7d908a319191a412` |
| `packages/db/tests/jobs.integration.test.ts` | `a12a02fea97a0f25bcf3b69f06e1e9dfac4278e3865c59e05d519ab26c9f1d54` |
| `packages/db/tests/postgres.integration.test.ts` | `33e6a202f124e093f338649fd6a02a9085392cbc3032952011bebb51cbfa41f0` |
| `packages/db/tests/architecture.test.ts` | `be9103fbff37454e8f204f5a68e0b1cf898e1d5f007824406f8248092f3a0e73` |
| `scripts/run-postgres-integration.mjs` | `82c62edb013981de445345d926c42432d3a5a054ff91a09ed9df0e7147a0e61f` |
| `pnpm-lock.yaml` | `bc8d151d62773d6dade80ec578a3943074c25d49cbf6d0f08237d13c983e7f3f` |

## Reader closure

- 架构 reader 发现 canonical JSON collision 与 checkpoint/provider 完成度表述过强；严格 JSON domain 和当前态文档修复后，无残留 P1/P2；
- 代码 reader 发现 transaction `now()` 锁等待漏洞、destructive test 误配风险、harness cleanup 泄漏/停服风险和 timestamp 镜像精度问题；改用锁后 `clock_timestamp()` 重检、ephemeral database guard、安全 cleanup 与 SQL 内 timestamp 复制后，最终无残留 P1/P2；
- 证据 reader 校正测试计数、CI guard 说明与真实 PostgreSQL 历史/当前证据边界；相关文档已同步。最新 5 项真实 PostgreSQL suite 已复跑通过，Iteration 0010 的证据门槛闭环。

## 不代表什么

- 本机 PostgreSQL 不代表托管 PostgreSQL、连接池代理或网络分区；
- journal 不让不支持 idempotency 的 provider 自动获得 exactly-once；
- `uncertain` 尚无通用自动 resolver；
- terminal event/article transaction 与 PostgresSaver checkpoint attempt isolation 尚未实现；
- 当前仍未切换 FastAPI/Python 运行路径。
