# Iteration 0041：Fenced Memory Extraction Effects

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0042](../decisions/0042-fenced-memory-extraction-effects.md)
- 评测记录：[Eval 0037](../evals/0037-fenced-memory-extraction-baseline.md)

## 目标

为post-run Memory extractor建立独立的durable attempt/effect ledger和provider-call fencing，使BullMQ重放不能在结果不明时重复调用收费模型，并保留content-free usage/cost审计证据。

## 范围内

- `memory_extraction_tasks/attempts/effects`三层PostgreSQL账本；
- 首次claim固定versioned execution snapshot和fingerprint；
- DB-time lease、heartbeat、并发claim与attempt预算；
- provider前置reservation和attempt-stable effect key；
- succeeded/failed/uncertain result fingerprint；
- provider/model/request id、usage、可选microusd pricing与latency计量；
- known failed retry与unknown outcome fail-closed；
- provider成功后下游失败、lease expiry和配置漂移的reconciliation边界；
- 三张表的workspace RLS与content-free断言；
- Worker service、BullMQ unrecoverable mapping、真实PostgreSQL/Redis回归。

## 范围外

- 不实现真实extractor prompt或Anthropic adapter composition；
- 不启用production Memory publisher/consumer；
- 不实现hard cost budget、daily workspace quota或pricing catalog；
- 不保存provider原始输出，不自动resolve `uncertain`；
- 不实现atomic candidate batch、管理API/UI、expiry scheduler或retrieval。

## 验证

- `pnpm test:db`：15个文件、97项通过；
- `pnpm test:worker`：10个文件、55项通过；
- `pnpm typecheck:db`、`pnpm typecheck:worker`、`pnpm check:migrations`：通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL DB 15项、PostgresSaver 4项、live sampler 1项通过；包含双连接claim serialization、expired reservation fail-closed和三表RLS；
- `pnpm test:worker:redis:local`：真实Redis/BullMQ 9项通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：通过；TypeScript 427项、Python 50项，共477项测试；component Eval 38/38、Memory governance Eval 18/18、workflow shadow Eval 3/3；Web lint/test/build、类型检查、migration check与132份Markdown链接检查全部通过；
- `git diff --check`：通过。

## 退出条件

1. 同一source run并发只有一个active extraction lease：满足。
2. provider调用前必须得到全新effect reservation：满足。
3. reserved/succeeded后的lease expiry不能自动再次调用provider：满足。
4. 只有adapter显式声明的known failed outcome可在新attempt重试：满足。
5. execution snapshot在attempt间不可漂移：满足。
6. ledger不保存topic、正文、prompt或模型输出：满足。
7. usage/cost metadata可查询且workspace RLS隔离：满足。
8. 真实PostgreSQL和Redis gate通过：满足。

## 后续

1. versioned extractor prompt与provider-neutral structured-output adapter；
2. hard per-run/workspace cost budget和pricing catalog；
3. utterance/article fixture与should-write precision/recall、slot accuracy、sensitive false-negative Eval；
4. calibration通过后只在shadow workspace启用consumer；
5. `uncertain` reconciliation API/告警与backlog SLO。
