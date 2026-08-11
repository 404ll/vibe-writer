# Iteration 0042：Provenance-aware Memory Extraction Calibration

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0043](../decisions/0043-provenance-aware-memory-extraction-calibration.md)
- 评测记录：[Eval 0038](../evals/0038-memory-extraction-quality-baseline.md)

## 目标

为真实Memory extractor建立版本化prompt、显式source provenance和可重复质量门禁，同时阻止当前task topic与assistant article被误写成长期用户Memory。

## 范围内

- `author/scope/text` trusted segment输入契约、字符预算和strict JSON output parser；
- versioned provider-neutral `TextModel` adapter与显式`sourceBuilder`；
- completed article的`user/task + assistant/task`来源标注；
- provider error到known-failed/uncertain effect语义映射；
- 24-case中英双语synthetic extraction dataset与独立reference target；
- should-write precision/recall/accuracy、slot/candidate exact、invalid output和task/assistant/sensitive leak scorer；
- tracked baseline、CLI和根级`pnpm verify`门禁；
- source provenance边界的architecture regression test。

## 范围外

- 不持久化新的user-authored durable signal；
- 不把真实Anthropic/OpenAI provider组合进production Memory Worker；
- 不启用production Memory publisher/consumer；
- 不把reference target结果表述为真实模型质量；
- 不实现hard per-run/workspace cost budget、pricing catalog或付费calibration；
- 不实现expiry scheduler、管理UI、embedding/retrieval或answer-uplift Eval。

## 验证

- `pnpm test:memory-core`：5个文件、22项通过；
- `pnpm test:worker`：11个文件、60项通过；
- 根级验证中的`pnpm test:eval-cli`：9个文件、32项通过；
- `pnpm typecheck:memory-core`、`pnpm typecheck:worker`、`pnpm typecheck:eval-cli`：通过；
- `pnpm eval:memory-extraction`：24/24通过；10 TP、14 TN、0 FP、0 FN，precision/recall/accuracy/slot exact均为1，task/assistant/sensitive leak均为0；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：通过；TypeScript 442项、Python 50项，共492项测试；component Eval 38/38、Memory governance Eval 18/18、Memory extraction Eval 24/24、workflow shadow Eval 3/3；Web lint/test/build、类型检查、migration check与135份Markdown链接检查全部通过；
- 本轮没有修改schema、repository或BullMQ delivery，因此未重复运行真实PostgreSQL/Redis专项门禁；Iteration 0041的真实基础设施证据仍负责该边界；
- `git diff --check`：通过。

## 退出条件

1. prompt输入不能丢失author/scope provenance：满足。
2. 当前terminal article source不能产生合法durable candidate：满足；topic与article均为task scope，article还是assistant-authored。
3. output必须通过strict schema且provider错误保留fenced effect语义：满足。
4. dataset同时覆盖durable positive与task/assistant/sensitive/ambiguous negative：满足。
5. baseline同时约束分类、slot和高风险泄漏：满足。
6. reference harness与真实模型production gate在文档和target identity上明确分离：满足。
7. production consumer保持关闭：满足。

## 后续

1. 建立user-authored durable signal的数据模型、显式consent入口和source/erasure传播；
2. 将该来源接到provider-neutral source builder，而不是重标现有task/article；
3. 加入hard per-run/workspace cost budget、pricing freshness和真实model target；
4. 扩展真实去标识化calibration set并人工审查false positive/false negative；
5. 全部门禁通过后才在shadow workspace启用consumer。
