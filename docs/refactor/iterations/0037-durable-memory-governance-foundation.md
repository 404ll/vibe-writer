# Iteration 0037：Durable Memory Governance Foundation

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0038](../decisions/0038-durable-memory-governance-and-erasure.md)
- 评测记录：[Eval 0033](../evals/0033-durable-memory-governance-baseline.md)

## 目标

把 Iteration 0036 的纯 policy 接入 workspace-scoped PostgreSQL 数据模型，形成 proposal → review → revision、conflict replace、retention 和 erasure 的最小持久化闭环。

## 范围内

- candidate、active memory、revision、candidate event 和 content-free tombstone schema；
- completed source run 与 workspace provenance；
- policy-owned candidate/duplicate/conflict/rejected 写入路径；
- editor review、explicit conflict replacement 与 revision compare-and-swap；
- viewer active read、editor candidate read/review、owner hard delete；
- retention expiry、active-slot retirement 和 source job/run deletion propagation；
- 五张表的 PostgreSQL RLS；
- PGlite repository/architecture gate 和真实 PostgreSQL non-owner role gate；
- workspace-scoped repository composition 与 package export。

## 范围外

- 不实现 extractor Worker、定时 expiry scheduler 或管理 UI；
- 不实现 embeddings、pgvector、semantic dedupe、retrieval 或 context assembly；
- 不实现 PII/sensitive classifier calibration；
- 不把 Memory 注入当前 Python 或 TypeScript 写作 workflow；
- 不声称已完成 should-write、retrieval 或 answer-uplift Eval。

## 验证

- `pnpm test:db`：14 个文件、91 项通过，其中 durable Memory 7 项；
- `pnpm typecheck:db`：通过；
- `pnpm check:migrations`：通过；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB 14 项、PostgresSaver 4 项、live sampler 1 项通过；Memory 数据树在非 owner API role 下通过有 scope 可见、无 scope 不可见的 RLS 验证；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 403 项、Python 50 项，共 453 项通过；component 38/38、workflow shadow 3/3、Web lint/test/build、全部 typecheck/migration check 和 120 个 Markdown 链接通过；
- `git diff --check`：通过。

## 退出条件

1. policy rejected proposal 不落库，candidate exact replay 幂等：满足。
2. duplicate 不产生新 candidate，conflict 不会隐式覆盖：满足。
3. materialize 和 replace 产生可追溯 revision：满足。
4. viewer/editor/owner 权限和跨 workspace 隔离可执行：满足。
5. explicit delete、retention 和 source deletion 清除正文：满足。
6. tombstone 不包含正文或可逆 slot identity：满足。
7. 真实 PostgreSQL RLS 与迁移门禁通过：满足。

## 后续

1. 为 should-write、duplicate/conflict 和 revision transition 建立 deterministic Memory Eval suite；
2. 将 extractor 接到 completed run 的独立 Worker/outbox 路径；
3. 建立 expiry maintenance 的调度、指标和 backlog alert；
4. 设计 retrieval port、pgvector adapter 和 workspace/subject filter；
5. 用 retrieval recall@k、context precision 和 answer uplift 决定是否进入 prompt。
