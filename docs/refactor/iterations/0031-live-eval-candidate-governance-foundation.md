# Iteration 0031：Live Eval Candidate Governance Foundation

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0032](../decisions/0032-live-eval-candidate-governance.md)
- 评测记录：[Eval 0027](../evals/0027-live-eval-candidate-governance-baseline.md)

## 目标

在 production sampler、grader 或 dataset 回灌读取用户内容前，建立 content-free candidate ledger、consent/retention 状态机、workspace 审批和 RLS 隔离。

## 范围内

- `eval_candidates` 与 append-only `eval_candidate_events` schema/migration；
- completed run/article 最小字段查询与 content fingerprint pointer；
- 0–9999 deterministic sampling bucket 和 immutable sampler version；
- consent basis/policy version、retention deadline 与 content classification；
- pending review、approve/reject、database-time expiry 和 event sequence；
- editor/owner review、viewer 拒绝、workspace-scoped read；
- 非 owner PostgreSQL role 的 candidate/event RLS gate；
- source deletion cascade 和无 raw content schema/architecture assertion。

## 范围外

- 不实现自动扫描 production run 的 scheduler/cursor；
- 不读取、复制、去标识化或 materialize article content；
- 不创建 user-content Eval suite/case，不调用 grader；
- 不提供浏览器/API 管理界面、consent policy CRUD 或 deletion tombstone；
- 不实现 CI artifact retention。

## 验证

- `pnpm test:db`：11 个文件、69 项通过；consent missing、pointer-only candidate、deterministic exclusion、idempotency/collision、viewer denial、workspace isolation、review replay 和 expiry event 通过；
- `pnpm typecheck:db`、`pnpm check:migrations`：通过；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB suite 11 项、PostgresSaver 4 项通过；非 owner role 只能读取当前 workspace candidate/event，无 scope 返回空；component register/enqueue 幂等检查继续通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 362 项、Python 50 项，共 412 项通过；38-case component gate、3-case workflow shadow、Web lint/build 和所有 typecheck/migration check 通过；
- `pnpm check:docs`：102 个 Markdown 文件链接通过；`git diff --check`：通过。

## 退出条件

1. 未提供 consent 不产生 candidate：满足。
2. sampler 查询与 ledger 都不加载/保存 topic 或正文：满足。
3. 同一 source/sampler version 确定且幂等，policy 漂移 fail closed：满足。
4. review/expiry 有 machine-readable append-only event：满足。
5. viewer 与跨 workspace/non-scoped API role 均无法读取或审批：满足。
6. approved 状态不会自动生成 Eval case：满足。

## 后续

1. production scanner cursor、backlog/SLO 与 consent policy resolver；
2. approved candidate 的去标识化/materialization 协议；
3. 固定 rubric、grader profile/trial/cost budget；
4. CI artifact/report retention 和 Memory Eval。
