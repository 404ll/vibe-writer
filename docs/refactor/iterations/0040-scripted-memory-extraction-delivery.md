# Iteration 0040：Scripted Memory Extraction Delivery

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0041](../decisions/0041-independent-memory-extraction-delivery.md)
- 评测记录：[Eval 0036](../evals/0036-scripted-memory-delivery-baseline.md)

## 目标

用 deterministic scripted extractor 打通 completed run → transactional outbox → independent BullMQ → trusted envelope → candidate repository，并证明重放不会自动产生 active Memory或重复 candidate。

## 范围内

- terminal transaction 内 Memory extraction outbox；
- pointer-only/versioned Memory queue protocol；
- 独立 BullMQ publisher/worker；
- completed source与revision 0读取边界；
- run `finishedAt` retention anchor；
- trusted-envelope composition和repository submission；
- policy rejected计数、candidate/conflict/duplicate计数；
- PGlite delivery integration与真实 Redis queue gate；
- terminal replay/outbox idempotency与真实 PostgreSQL回归。

## 范围外

- 不启用 production Memory consumer；
- 不调用真实模型或引入 extractor prompt；
- 不提供 provider effect ledger、cost budget或收费 smoke；
- 不提供 atomic multi-candidate transaction；当前依靠逐项幂等重放收敛；
- 不自动审批或注入写作上下文；
- 不实现 expiry scheduler、管理 API/UI或 retrieval。

## 验证

- `pnpm test:db`：14 个文件、92 项通过；
- `pnpm test:worker`：10 个文件、52 项通过；
- `pnpm typecheck:db`、`pnpm typecheck:worker`：通过；
- `pnpm test:worker:redis:local`：真实 Redis 9 项通过，包含独立 Memory queue端到端；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 14项、PostgresSaver 4项、live sampler 1项通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：通过；TypeScript 419 项、Python 50 项，共 469 项测试；component Eval 38/38、Memory governance Eval 18/18、workflow shadow Eval 3/3；Web lint/test/build、类型检查、migration check与 129 份 Markdown 链接检查全部通过；
- `git diff --check`：通过。

## 退出条件

1. article terminal 与 extraction request无双写窗口：满足。
2. Redis payload不包含正文或 proposal：满足。
3. Memory queue与写作队列独立：满足。
4. queue replay只保留一个 candidate identity：满足。
5. sensitive model inference仍由 policy拒绝且不落库：满足。
6. candidate不会自动 materialize：满足。
7. 真实 Redis和PostgreSQL gate通过：满足。

## 后续

1. extraction attempt/effect ledger与provider-call fencing；
2. versioned prompt、model profile、usage/cost budget；
3. utterance/article fixture与should-write precision/recall Eval；
4. 通过 calibration 后才在shadow workspace启用真实 consumer；
5. expiry scheduler和backlog/erasure latency指标。

后续进展：Iteration [0041](./0041-fenced-memory-extraction-effects.md)已完成第1项，并把scripted delivery接入独立DB lease、attempt/effect ledger与unknown-outcome fail-closed。
