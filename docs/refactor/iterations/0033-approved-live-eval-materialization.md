# Iteration 0033：Approved Live Eval Materialization

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0034](../decisions/0034-approved-live-eval-materialization.md)
- 评测记录：[Eval 0029](../evals/0029-approved-live-eval-materialization-baseline.md)

## 目标

在不绕过 workspace approval 的前提下，把 approved candidate 批量转换为可版本化、可清理、默认不可运行的 Eval dataset，并封闭 generic user-content ingest 和结果树 RLS 缺口。

## 范围内

- `materialized` candidate 状态/event；
- Eval case 的 source candidate、retention 与 materializer metadata；
- owner-only、1–100 candidate 的原子 batch materialization；
- article revision/fingerprint freshness recheck；
- workspace namespace、immutable dataset fingerprint 和 draft-by-default suite；
- owner activation 与运行/claim/report 前治理重检；
- retention expiry 的 case purge + suite archive；
- source candidate deletion 的 case cascade；
- `eval_cases/runs/trials/scores` 完整 RLS；
- generic `user_content` suite creation fail closed。

## 范围外

- 不实现去标识化、PII redaction、expected answer 或 rubric 生成；
- 不自动 activate 或自动 enqueue Eval run；
- 不实现 materialization queue、API/UI 或批次管理页面；
- 不实现真实 model grader、cost budget、CI artifact 或 Memory Eval；
- 不证明 backup、replica、object storage 中的 retention 删除。

## 验证

- `pnpm test:db`：13 个文件、83 项通过；包括 owner gate、generic user-content bypass denial、batch/replay、stale source rollback、expiry purge/archive、activation 与 fingerprint revalidation；
- `pnpm typecheck:db`、`pnpm check:migrations`、`git diff --check`：通过；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB suite 13 项、PostgresSaver 4 项、Live sampler runtime 1 项通过；补 RLS 前测试真实发现无 scope role 可读取 `eval_cases`，补齐 dataset/result tree RLS 后复验为 0 行；删除 source job 后 materialized case 为 0；component register/enqueue 幂等 gate 继续通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 379 项、Python 50 项，共 429 项通过；38-case component gate、3-case workflow shadow、Web lint/build、全部 typecheck/migration check 和 108 个 Markdown 链接通过。

## 退出条件

1. 未 approved、非 owner、跨 workspace 或 stale source 均不能 materialize：满足。
2. batch/suite/case/candidate event 全部原子且可幂等重放：满足。
3. user content 默认 draft，activate 前后都重验 fingerprint/retention：满足。
4. retention/source deletion 会清除 case 正文并阻止 suite 运行：满足。
5. 无 scope API role 看不到 workspace Eval dataset/result tree：满足。
6. 根级验证和文档链接通过：满足。

## 后续

1. 固定 rubric、真实 model grader profile、多 trial 与 cost budget；
2. grader queue target registry 与 user-content output capture policy；
3. CI artifact/report retention；
4. Memory candidate/revision/retrieval 与专项 Eval。
