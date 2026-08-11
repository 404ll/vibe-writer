# Iteration 0023：跨运行时 Workflow Shadow Gate

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0024](../decisions/0024-cross-runtime-workflow-shadow-gate.md)
- 评测记录：[Eval 0019](../evals/0019-cross-runtime-workflow-shadow-baseline.md)

## 目标

让同一批合成 workflow 场景真实经过当前 Python LangGraph 和目标 TypeScript LangGraph，并用显式产品预期约束双方，形成可重复、无网络、无产品持久化的迁移回归门禁。

## 范围内

- 新增共享 workflow shadow schema 与 3 个 versioned scenario；
- 建立 Python graph 的 scripted provider/search/export driver；
- 建立 TypeScript graph 的 scripted `WorkflowServices` driver；
- 比较双方 normalized observation 和显式 expected；
- 建立 report、candidate baseline 和只读 check 命令；
- 把 workflow shadow gate 纳入根级 `pnpm verify`；
- 更新 Eval CLI、系统设计、路线图、ADR、迭代和评测证据。

## 范围外

- 不访问真实模型、搜索网络或数据库；
- 不写 `output/` 或文章记录；
- 不比较内部 graph state/checkpoint envelope；
- 不实现跨 runtime Worker/Redis/PostgreSQL production E2E；
- 不覆盖异常、取消、并行章节或主观文章质量；
- 不改变产品流量或 Python 运行时。

## 数据流

```text
versioned synthetic scenario + explicit expected
  ├─→ current Python build_graph + scripted adapters ─→ normalized observation
  └─→ TypeScript buildWorkflowGraph + scripted services ─→ normalized observation
                     ↓
       Python == expected && TS == expected && Python == TS
                     ↓
          self-owned Eval report + tracked baseline gate
```

## 场景

| Case | 控制流 | 关键断言 |
|---|---|---|
| `happy-no-intervention` | plan → write → review → export | 一次写作、一次全文审稿、正文一致 |
| `edited-outline-confirm` | plan → outline review → write → review → export | 编辑后的大纲进入两边正文 |
| `full-review-rewrite` | plan → write → review → write → review → export | 两次写作、两次全文审稿、最终 v2 正文 |

## 安全边界

- Python 子进程使用最小环境，不继承 Anthropic、Tavily、数据库等应用凭据；
- Python export node 被 side-effect-free adapter 替换；
- fixture 全部标记为 synthetic，不使用用户内容；
- 默认 Eval report 不 capture output body；
- runtime error 在 report 中只保存通用 target error，测试诊断只显示合成运行堆栈。

## 验证

- `pnpm test:contracts`：2 个文件、21 项通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm test:eval-cli`：3 个文件、11 项通过，其中两个 runtime 的 3 个场景和完整 Eval report 均通过；
- `pnpm typecheck:contracts`、`pnpm typecheck:eval-cli`：通过；
- `pnpm eval:components`：38/38 component exact match 继续通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm eval:workflow-shadow`：3/3 cross-runtime exact match，0 target/evaluator error；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 336 项、Python 50 项，共 386 项测试通过；Web lint/build、全部 typecheck、migration check 和两个 Eval gate 通过；
- `pnpm check:docs`：78 个 Markdown 文件链接通过；
- `git diff --check`：通过。

## 退出条件

1. 两个 runtime 都实际执行 3 个共享场景；
2. 三重比较全部通过；
3. baseline 能阻断 runtime error、dataset/case/score/pass-rate 漂移；
4. gate 无网络、数据库和文章文件副作用；
5. 根级 verify 通过；
6. 未覆盖的 production E2E、live eval 和 Memory 明确保留。

## 回滚

移除 workflow shadow 命令、fixture、driver 和 baseline 不改变产品 runtime，但会失去跨语言控制流迁移证据。组件 gate 与 PostgreSQL Eval schema 可独立保留。

## 后续

1. 扩展异常、取消和多章节并行场景；
2. 在 production composition harness 比较 durable event/article projection；
3. 接 CI content-free artifact retention 和 baseline run id；
4. auth/workspace 后接独立 Eval queue、RLS 与 live sampler；
5. Memory 落地后加入 isolation/retrieval/answer-gain shadow suite。
