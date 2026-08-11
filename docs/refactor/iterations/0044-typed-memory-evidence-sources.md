# Iteration 0044：Typed Memory Evidence Sources

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0045](../decisions/0045-typed-memory-evidence-sources-and-derived-erasure.md)
- 评测记录：[Eval 0040](../evals/0040-typed-memory-source-erasure-baseline.md)

## 目标

把Memory proposal/candidate的证据来源从run-only提升为严格`run | signal` identity，并证明撤回signal会清除全部已落库的派生Memory正文。

## 范围内

- `MemoryEvidenceSourceSchema`与proposal schema v2；
- trusted extraction envelope和现有run Worker source shape迁移；
- candidate `source_kind/run_id/signal_id`互斥约束、partial unique index和migration；
- signal workspace/subject/evidence/consent/retention可信重验；
- signal删除对candidate/event/active Memory/revision的数据库级联；
- PGlite forged-source与级联测试、真实PostgreSQL级联测试；
- Memory governance suite/baseline v2，新增signal与legacy-shape cases；
- 系统设计、ADR、路线图、Iteration和Eval记录同步。

## 范围外

- 不修改run-keyed extraction task/attempt/effect identity；
- 不增加signal extraction outbox、BullMQ payload或consumer；
- 不增加HTTP consent API、管理UI、embedding或cache；
- 不启用production Memory extraction；
- 不调用真实模型，不做cost/quality calibration。

## 验证

- `pnpm test:memory-core && pnpm typecheck:memory-core`：5个文件、23项通过；
- `pnpm test:db && pnpm typecheck:db && pnpm check:migrations`：16个文件、105项通过，migration无drift；
- `pnpm test:worker && pnpm typecheck:worker`：11个文件、60项通过；
- `pnpm test:eval-cli && pnpm typecheck:eval-cli && pnpm --filter @vibe-writer/eval-cli memory:check`：Eval CLI 28项通过、4项环境跳过；Memory governance v2为20/20；
- `pnpm test:db:postgres:local`：真实PostgreSQL DB 16项、PostgresSaver 4项、live sampler 1项通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：通过；TypeScript 451项、Python 50项，共501项测试；component Eval 38/38、Memory governance Eval 20/20、Memory extraction Eval 24/24、workflow shadow Eval 3/3；Web lint/test/build、全仓类型检查、migration check与141份Markdown链接检查全部通过；
- `git diff --check`：通过。

## 退出条件

1. proposal不能用未标记source shape：满足。
2. candidate必须且只能引用一个run或signal：满足。
3. signal proposal不能伪造workspace、subject、evidence、consent或retention：满足。
4. signal删除必须清除candidate、event、active Memory和revision：PGlite与真实PostgreSQL均满足。
5. 旧run Worker和candidate行为保持兼容：满足。
6. 当前production边界不得被误写成signal自动提取已启用：满足。

## 后续

1. 将extraction task/attempt/effect和queue envelope迁到typed source identity；
2. 定义signal删除与in-flight reservation/uncertain effect的协调规则；
3. 增加staging consent API和source-scoped enqueue；
4. 再进行hard cost budget、真实model calibration和shadow consumer；
5. embedding/cache落地时加入同一source erasure contract。
