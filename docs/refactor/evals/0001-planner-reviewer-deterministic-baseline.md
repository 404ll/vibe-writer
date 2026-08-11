# Eval 0001：Planner/Reviewer 确定性基线

- 日期：2026-08-07
- Dataset：`agent-component-baseline-v1`
- Dataset schema：1
- Python baseline：`python-c47cbfd0ab1f`
- TypeScript agent core：`agent-core-v1`
- Planner prompt：`planner-v1-python-baseline-2026-08-07`
- Chapter reviewer prompt：`chapter-reviewer-v1-python-baseline-2026-08-07`
- Full reviewer prompt：`full-reviewer-v1-python-baseline-2026-08-07`

## 运行 provenance

- Git base revision：`c47cbfd0ab1f05630f189c9aecfe0ab8ec50033f`
- Worktree：dirty，运行时共有 51 个 tracked/untracked 状态项；本轮没有 commit，因此不能只用 base revision 复现 TS patch
- Node.js：`v22.14.0`
- pnpm：`10.0.0`
- Python：`3.14.5`

为使未提交实现仍可精确核对，本次评测记录相关 artifact SHA-256：

| Artifact | SHA-256 |
|---|---|
| `packages/model-runtime/src/types.ts` | `c274d179df2c0112cf16fe091b7bb904ca84d0ae4b48651b5f07dde9dd746274` |
| `packages/model-runtime/src/json.ts` | `80c9c259809e7c64cfb3997041d56fe92ef5cafceb91d881b048384d24a5bf1c` |
| `packages/agent-core/src/prompts.ts` | `23d950600b59692b8c7e319ac4686bdca61d32c89f8629821e261c7f5b6ea955` |
| `packages/agent-core/src/planner.ts` | `70e33e803e0b1b8ce96c9c5b972a6c47163fee365434e745998c449066d7a690` |
| `packages/agent-core/src/reviewer.ts` | `55dd83314055015f2912bff77ff1031d34e8195302f68be44d0647f3396d5c05` |
| `packages/agent-core/src/versions.ts` | `2123dcbac7a9b7f06db49ebb353de692815a352bd6d6e53ddd644906c9d5a5bb` |
| `packages/contracts/fixtures/agent-component-baseline.json` | `8904251114f5f07084e6dfcf53d94050a69d7952bdaf3f09fe2bbd1cb0ef7d91` |

后续若提交这些改动，应在新 eval 记录中改用包含实现的 commit SHA；不能把当前 base revision 误写成 TS 实现 revision。

## 评测范围

共享 dataset 位于 `packages/contracts/fixtures/agent-component-baseline.json`，由 Zod schema 校验。Python 和 TypeScript 分别读取同一文件：

- Planner：编号解析、噪音过滤、全角数字、章节数量裁剪；
- Model utility：直接 JSON、Markdown fence、前后文本和非法 JSON；
- Reviewer：合法结果、非法 JSON、非法字段类型、全文结果缺失；
- TS-only boundary：operation/prompt version/AbortSignal 传递、确定性字数门槛、Unicode code-point 计数、Python rounding 语义和禁止基础设施依赖。

## Compatibility 与 Target

| Case | Python compatibility | TypeScript target | 结论 |
|---|---|---|---|
| 合法 chapter/full JSON | 保持 passed/failed | 保持 passed/failed | 等价 |
| 非法 JSON | 默认 passed | inconclusive | intentional safety delta |
| `passed` 为字符串 | Python truthiness 变成 passed | schema 拒绝并 inconclusive | intentional safety delta |
| full results 少于章节数 | 缺失项补 passed | 缺失项 inconclusive | intentional safety delta |

Planner fixture 与 JSON object tolerance 的所有 compatibility case 在两种实现中一致。Reviewer 的差异由 ADR-0006 明确批准，不能归类为 regression。

## 结果

```text
contracts:     12 passed
model-runtime:  8 passed
agent-core:    31 passed
Python API:    45 passed
Web:           12 passed + lint + production build
DB:             8 passed + typecheck + migration check
```

完整命令：

```bash
API_PYTHON=/absolute/path/to/.venv/bin/python pnpm verify
```

结果：通过。

`pnpm check:docs` 由 `scripts/check-markdown-links.mjs` 实现，扫描根文档、核心 package README 和 `docs/refactor`，本次共检查 22 份 Markdown；它已包含在 `pnpm verify` 中。`git diff --check` 在 verify 之外单独运行。两者均通过。

## 不代表什么

- 没有调用真实 provider，不能证明模型输出质量或供应商 adapter 正确；
- 没有固定文章 dataset 或 LLM judge，不能证明 Planner/Reviewer 主观质量与 Python 等价；
- 没有组装 LangGraph.js，不能证明 interrupt、rewrite loop 或 checkpoint 行为；
- Planner/Reviewer 还没有接入 Worker 或流量。

这些边界将在 provider adapter、组件 dataset 和 graph shadow run 建立后扩展为后续 eval 记录。
