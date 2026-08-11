# Iteration 0030：Independent Durable Eval Queue

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0031](../decisions/0031-independent-durable-eval-queue.md)
- 评测记录：[Eval 0026](../evals/0026-independent-durable-eval-queue-baseline.md)

## 目标

把同步 Eval runner 产品化为独立 durable execution plane：PostgreSQL 保存请求与结果，BullMQ 只传 run pointer，Eval consumer 不占用写作队列，并以 lease/fencing 防止重复或过期 Worker 写入。

## 范围内

- queued/inline Eval mode、idempotency key、attempt、lease、heartbeat 与 lifecycle 数据库约束；
- `enqueueRun`、claim/heartbeat/takeover、fenced context、原子 report commit 与 fail claim；
- `eval.run.requested` transactional outbox 和 aggregate-scoped dispatcher；
- pointer-only Eval queue protocol、独立 BullMQ publisher/worker、角色化进程入口与配置；
- component definition/execution 分离和 fail-closed target registry；
- CLI `enqueue`、真实 Redis/PGlite E2E、真实 PostgreSQL migration/enqueue gate；
- write queue 与 Eval queue 的隔离断言。

## 范围外

- 不接入生产 trace live sampler 或用户内容；
- 不实现真实模型 grader、rubric registry 或 CI artifact 上传；
- 不实现 Eval cancel/reconciler、优先级、配额和成本预算；
- 不修改浏览器/API 默认切流，也不退休 Python。

## 验证

- `pnpm test:eval-cli`：局部运行 4 个文件、13 项通过，workflow shadow 的 4 项在未提供 Python 时按约定跳过；全量门禁提供 Python 后 17 项全部通过；
- `pnpm typecheck:eval-cli`：通过；
- `pnpm test:eval-queue:local`：真实 Redis gate 1 项通过；pointer-only delivery、38 trial、38 score、content-free output、outbox publish 和 write queue 隔离均满足；
- `pnpm test:db`：10 个文件、64 项通过；outbox lane 隔离、queued request、原子 report、过期 lease takeover 与 stale-token fencing 通过；
- `pnpm typecheck:db`、`pnpm typecheck:worker`、`pnpm check:migrations`：通过；
- `pnpm test:db:postgres:local`：真实 PostgreSQL migration、双 session DB/Checkpoint 测试、component register/enqueue 幂等与 pointer-only outbox 通过；
- `pnpm test:worker:production:local`：既有 production projection 4 项通过，证明 outbox aggregate 分流没有破坏写作主链；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 357 项、Python 50 项，共 407 项通过；38-case component gate、3-case workflow shadow、Web lint/build 和所有 typecheck/migration check 通过；
- `pnpm check:docs`：99 个 Markdown 文件链接通过；`git diff --check`：通过。

## 退出条件

1. enqueue 不执行 suite，request/outbox 事务内持久化：满足。
2. Redis 只传 Eval run pointer，写作队列不被 Eval consumer 消费：满足。
3. duplicate delivery 与 lease takeover 不能产生重复/部分 report：满足。
4. 38-case component target 可由独立 worker 完成并原子落库：满足。
5. migration、局部门禁、真实 Redis 和真实 PostgreSQL 均可重复运行：满足。

## 后续

1. production trace live sampler、consent/retention 与 dataset candidate；
2. 固定 rubric、真实模型 grader、judge 多 trial 和 cost budget；
3. CI artifact/report retention 与历史趋势；
4. Memory candidate/retrieval/governance Eval。
