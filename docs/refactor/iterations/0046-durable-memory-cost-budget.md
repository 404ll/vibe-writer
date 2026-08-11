# Iteration 0046：Durable Memory Cost Budget

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0047](../decisions/0047-durable-memory-extraction-cost-budget.md)
- 评测记录：[Eval 0042](../evals/0042-memory-cost-budget-fault-baseline.md)

## 目标

在Memory extraction provider调用前执行可跨Worker并发的source/workspace hard cost budget，并把预留、实际计量和unknown占额固化为content-free审计。

## 范围内

- provider-neutral pricing/budget schema、最大预留与usage计价；
- budget policy进入execution snapshot/fingerprint；
- effect budget metadata、migration、check与workspace/day索引；
- PostgreSQL workspace row锁、source/workspace聚合与policy drift拒绝；
- Worker prompt bytes预估、extractor max token一致性和provider前budget rejection；
- usage缺失、实际超预留和pricing drift的fail-closed边界；
- PGlite、真实PostgreSQL双session并发与Worker provider-call-count测试；
- ADR、Iteration、Eval、系统设计与路线图同步。

## 范围外

- 不实现`uncertain` provider账单/result resolver；
- 不增加HTTP预算配置、管理UI、告警或自定义workspace时区；
- 不启用production Memory consumer；
- 不调用真实模型，不接受真实should-write质量baseline；
- 不实现embedding/retrieval或Agent context assembly。

## 验证

- `pnpm test:memory-core && pnpm typecheck:memory-core`：6个文件、26项通过；
- `pnpm check:migrations && pnpm typecheck:db && pnpm test:db`：migration无drift，DB 16个文件、109项通过；
- `pnpm typecheck:worker && pnpm test:worker`：Worker 11个文件、67项通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL DB 18项、PostgresSaver 4项、live sampler 1项通过；
- `pnpm test:worker:redis:local`：真实Redis/BullMQ 9项通过，run/signal均经过budget-enabled consumer；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：component Eval 38/38、Memory governance 20/20、Memory extraction 24/24、workflow shadow 3/3，以及全仓测试、类型、Web lint/build和migration gate通过；
- `pnpm check:docs && git diff --check`：147份Markdown链接与diff whitespace检查通过。

## 退出条件

1. 预算不足必须在provider调用前失败且不创建effect：满足。
2. 两个真实PostgreSQL session不能双花workspace日预算：满足。
3. known failure释放预留，uncertain保留预留：满足。
4. budget/pricing/max token必须进入不可漂移execution与effect证据：满足。
5. budgeted success必须由usage和pricing snapshot计算实际费用：满足。
6. migration、根级gate与文档链接全部通过：满足。

## 后续

1. 设计`uncertain` reconciliation状态机、provider evidence和审计权限；
2. 增加workspace budget配置API、预警阈值与运营查询；
3. 运行真实Memory extractor model的质量/费用calibration；
4. staging shadow consumer证明后再评估production启用。
