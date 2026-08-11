# Iteration 0032：Automatic Live Eval Sampling

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0033](../decisions/0033-versioned-live-eval-sampling-policy.md)
- 评测记录：[Eval 0028](../evals/0028-automatic-live-eval-sampling-baseline.md)

## 目标

把手动的 single-run candidate sampling 扩展为 versioned workspace policy、durable cursor 和独立 sampler process，同时保持 candidate content-free、审批前不复制正文。

## 范围内

- `eval_sampling_policies` schema、migration、owner-only configuration、disable/list 与 RLS；
- policy version collision、active replacement 和 cursor inheritance；
- completed run 的 `(finished_at, run_id)` bounded cursor；
- `FOR UPDATE SKIP LOCKED` 多实例 policy claim；
- `last_scanned_at` 公平轮转，空 workspace 也释放下一轮优先级；
- candidate/event/cursor 同事务提交，missing article 和 collision fail closed；
- `apps/eval` 独立 polling loop、显式配置、schema readiness 和 signal shutdown；
- 真实 PostgreSQL 的 RLS、并发扫描与实际 runtime 首 tick gate。

## 范围外

- 不提供浏览器/API policy 管理界面或 hosted scheduler 配置；
- 不读取、复制、去标识化或 materialize article content；
- 不自动审批 candidate，不创建 Eval suite/case/run；
- 不调用真实模型 grader，不实现 cost budget 或 CI artifact；
- 不实现 consent 撤回、source deletion tombstone、backlog/SLO metric 或多 region leader election。

## 验证

- `pnpm test:db`：12 个文件、76 项通过；包括 policy 权限/版本、cursor batch、replacement inheritance、disable、fair rotation、missing article 回滚和 content-free architecture gate；
- `pnpm test:eval-cli`：16 项通过、4 项因未提供 Python interpreter 按预期跳过；sampler immediate tick、poll、error recovery、close 与 explicit enable config 通过；
- `pnpm typecheck:db`、`pnpm typecheck:eval-cli`、`pnpm check:migrations`、`git diff --check`：通过；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB suite 12 项、PostgresSaver 4 项、sampler runtime 1 项通过；两个 backend session 分别扫描两个 workspace policy，非 owner role RLS 与无 scope 空结果通过；component register/enqueue 幂等 gate 继续通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 372 项、Python 50 项，共 422 项通过；38-case component gate、3-case workflow shadow、Web lint/build、全部 typecheck/migration check 和 105 个 Markdown 链接通过。

## 退出条件

1. policy 变更必须 versioned 且由 owner 执行：满足。
2. scanner 重启从 durable cursor 继续，replacement 不重扫历史：满足。
3. 多实例可跳过已锁 policy，空 workspace 不造成饥饿：满足。
4. candidate/event/cursor 原子提交，错误不前移 cursor：满足。
5. scanner 与 candidate 不加载/保存 production 正文：满足。
6. 独立 runtime 在真实 PostgreSQL 首 tick 可生成 governed pointer：满足。
7. 根级验证与文档链接全部通过：满足。

## 后续

1. approved candidate 的 pointer-only batch claim、source freshness recheck、去标识化/materialization；
2. 固定 rubric、真实 model grader profile、trial 和 cost budget；
3. CI artifact/report retention；
4. Memory candidate/revision/retrieval 与专项 Eval。
