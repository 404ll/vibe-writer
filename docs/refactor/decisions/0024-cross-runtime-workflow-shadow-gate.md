# ADR-0024：跨运行时 Workflow Shadow Gate

- 状态：Accepted
- 日期：2026-08-07

## 背景

Iteration 0022 的组件 gate 只执行 TypeScript target；Python compatibility 由分散的 pytest 和共享解析 fixture 证明。它不能回答同一个完整控制流场景经过当前 Python LangGraph 与目标 TypeScript LangGraph 后，是否得到相同的用户可见大纲、正文、重写次数和阶段顺序。

直接比较两个 runtime 的内部 state 不成立：Python 使用进程内 outline wait loop，TypeScript 使用 LangGraph interrupt/resume；章节字段、checkpoint envelope 和 export 边界也不同。只比较两边是否相等又不够，因为两边可能同时偏离显式产品预期。

## 决定

1. 建立 `workflow-shadow-baseline-v1`，每个场景同时包含脚本输入和显式 normalized expected observation。
2. 每个 trial 实际执行当前 Python `build_graph()` 与 TypeScript `buildWorkflowGraph()`；模型、搜索和 export 使用确定性 adapter，不复制 graph 控制流。
3. Python driver 只替换 agent/search/export adapter；export 不写 SQLite、`output/` 或 PostgreSQL。子进程不继承应用凭据，只接收 `PATH`、`PYTHONPATH` 和 Python runtime flags。
4. observation 只比较双方都承诺的产品语义：终态、最终大纲、规范化 Markdown、plan/write/review/export 阶段序列、outline review 次数、write 次数和 full-review 次数。
5. Markdown 只规范化连续三个以上换行为两个换行，用于吸收已知格式空行差异；不删除标题、正文或其他字符。
6. evaluator 必须同时满足 `Python == expected`、`TypeScript == expected`、`Python == TypeScript`。任意一项失败即 regression，避免共同漂移被误判为通过。
7. tracked baseline 固定 suite/dataset/case/target/metric gate；候选 baseline 仍只打印 stdout，不能自动写回。
8. `pnpm eval:workflow-shadow` 纳入根级 `pnpm verify`，并在 Python pytest 之后执行。它需要与 `test:api` 相同的 `API_PYTHON` 解释器约定。

## 当前场景

- 无人工介入的 happy path；
- 编辑大纲后确认；
- 第一轮全文审稿失败后重写并在第二轮通过。

## 不变量

- fixture 必须是 synthetic，不能包含真实用户文章、密钥或付费模型原始输出。
- 普通 report 默认只有 output fingerprint；正文只存在于 fixture expected 和进程内 observation。
- Python driver 失败、TypeScript target 失败和 evaluator 失败必须显式使 run failed。
- baseline 不能只比较两种实现而没有独立 expected。
- shadow gate 不能访问网络、产品数据库或写文章文件。

## 明确限制

- 这是 graph workflow shadow，不是 Next API、BullMQ、Redis、PostgreSQL、PostgresSaver 的跨运行时 E2E。
- Python 的 wait loop 与 TypeScript durable interrupt 只比较确认后的产品结果，不证明 checkpoint、进程重启恢复或并发隔离等价。
- 当前不覆盖取消、异常终态、搜索/tool call、并行多章节、真实 provider 或文章主观质量。
- Python runtime retirement 前仍需 production composition shadow、实际 source dry-run 和 live sampled eval。

## 未选择

- 只给 TypeScript 写 workflow snapshot：不能证明迁移兼容性。
- 只比较 Python 与 TypeScript：两边共同漂移时会静默通过。
- 在 shadow gate 调真实 provider：结果不确定、产生费用，并会把回归门禁绑定网络和供应商。
- 强行比较内部 state/checkpoint：两种实现的内部模型不同，会把安全的架构改进误判成回归。
