# Iteration 0034：Versioned Model Grader 与 Cost Budget

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0035](../decisions/0035-versioned-model-grader-and-cost-budget.md)
- 评测记录：[Eval 0030](../evals/0030-versioned-model-grader-baseline.md)

## 目标

让 approved live article suite 能在独立 durable Eval queue 上运行固定 rubric、多 trial 的模型评分，并把身份、失败、usage 和 cost 变成可复现、可聚合、可预算约束的工程数据。

## 范围内

- provider-neutral `eval-graders` package 与固定 article rubric；
- 严格 JSON grader response、criterion identity 校验和本地加权决策；
- versioned judge/profile/prompt/pricing/budget execution snapshot；
- provider call 前 max-call/max-cost 保守 reservation；
- usage settlement、unmetered/over-budget fail closed；
- `eval_scores` 结构化 model metering migration；
- live article target registry、manual idempotent enqueue 和 `captureOutput=false`；
- Anthropic wire adapter loopback、多 trial 和真实 Redis/BullMQ durable integration。

## 范围外

- 不执行付费 external provider call，不宣称 judge 质量或文章质量等价；
- 不自动 activate suite 或自动从 sampler enqueue；
- 不实现 workspace 日/月 quota、并行 grader reservation 或 chargeback UI；
- 不实现 grader calibration、human agreement、pairwise/ensemble judge；
- 不实现 CI artifact retention、Langfuse export 或 Memory Eval。

## 验证

- `pnpm test:eval-core`：3 个文件、8 项通过；
- `pnpm test:eval-graders`：1 个文件、4 项通过；覆盖双 trial、严格 response、provider-call 前预算拒绝和 cache token 定价；
- `pnpm test:eval-cli`：局部环境 6 个文件、20 项通过、4 项跳过；根级环境 24 项通过；覆盖 Anthropic loopback、identity drift、默认关闭、显式配置和 package boundary；
- `pnpm test:db`：13 个文件、83 项通过；migration 与既有 Eval repository 行为保持兼容；
- `pnpm test:eval-queue:local`：真实 Redis/BullMQ 集成 2 项通过；approved/materialized/active article 经 pointer-only job 执行 2 trials，结构化计量落库且 output 为 null；
- `pnpm test:db:postgres:local`：真实 PostgreSQL DB suite 13 项、PostgresSaver 4 项、live sampler 1 项通过；component register/enqueue 幂等 gate 继续通过；
- `pnpm check:migrations`、`git diff --check`：通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 387 项、Python 50 项，共 437 项通过；38-case component gate、3-case workflow shadow、Web lint/test/build、全部 typecheck/migration check 和 111 个 Markdown 链接通过。

## 退出条件

1. 模型不能直接控制最终 pass，rubric/key/score drift 必须 fail closed：满足。
2. 预算不足必须在 provider call 前拒绝，已调用但无 usage 后不得继续消费预算：满足。
3. 成功与可计量失败的 provider/model/token/cost 可结构化查询：满足。
4. queue request 只含 run pointer，user-content output 不复制到 trial：满足。
5. 默认关闭且 execution/config identity 漂移不能运行：满足。
6. 真实 PostgreSQL migration 与根级验证全部通过：满足。

## 后续

1. CI artifact/report retention 与 baseline comparison；
2. 小规模、人工复核的真实 judge calibration，形成 rubric agreement 基线；
3. workspace quota/alert 与并行 reservation ledger；
4. Memory candidate、revision、retrieval 与专项 Eval。
