# Eval 0018：组件回归 Gate 基线

- 日期：2026-08-07
- 结论：Passed for deterministic component regression gate
- 对应迭代：[0022](../iterations/0022-component-eval-baseline-gate.md)

## Identity

| 项目 | 值 |
|---|---|
| suite | `component-regression@2026-08-07-v1` |
| dataset fingerprint | `sha256:5b5be39e7de72c80e5f413c9e95cdc3baf27a05069475ef4fb4eee7bb703a3f0` |
| target | `typescript-agent-components@v1` |
| evaluator | `canonical-exact-match@v1` |
| model profile | `scripted:component-fixtures-v1` |
| prompt | 当前 `PROMPT_SET_VERSION` |
| graph | `component-no-graph-v1`，本 suite 不执行 graph |
| tool | 当前 Writer toolset version |
| code revision | 运行时对相关 TypeScript source 计算 SHA-256；不固定在 baseline |

## 结果

| 指标 | Gate | 实际 | 结论 |
|---|---:|---:|---|
| unique cases | 38 | 38 | Passed |
| trials | 38 | 38 | Passed |
| target errors | ≤ 0 | 0 | Passed |
| evaluator errors | ≤ 0 | 0 | Passed |
| exact-match scores | 38 | 38 | Passed |
| exact-match pass rate | ≥ 1.0 | 1.0 | Passed |

case inventory 覆盖 Planner outline/trim、JSON tolerance、Reviewer、Coverage、Search policy/ranking 与 Writer tool loop。tracked manifest 位于 `apps/eval/baselines/component-regression-v1.json`。

## Gate 故障注入

eval-core 测试对报告注入以下变化，compare 必须返回失败：

- dataset fingerprint 变化；
- case inventory 变化；
- evaluator error 增加；
- exact-match pass rate下降；
- invalid/under-specified baseline manifest；
- failed report 尝试生成新 baseline。

## PostgreSQL 注册证据

真实临时 PostgreSQL 上连续执行两次 `pnpm eval:components:register`：第一次 `suiteCreated=true`，第二次 `suiteCreated=false`，suite id 相同；最终 SQL gate 验证 1 suite、38 cases、2 completed runs、76 succeeded trials 和 76 passed scores。临时数据库随后停止并清理。

根级 `pnpm verify` 共通过 TypeScript 327 项与 Python 50 项测试，合计 377 项；同时通过所有 typecheck、migration check、Web lint/build、组件 baseline gate 和 75 个 Markdown 文件链接检查。

## 命令

```text
pnpm test:eval-core
pnpm typecheck:eval-core
pnpm test:eval-cli
pnpm typecheck:eval-cli
pnpm eval:components
pnpm test:db:postgres:local
API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify
pnpm check:docs
git diff --check
```

## 未证明

- fixture 是 synthetic deterministic dataset，不证明真实文章质量、citation、搜索来源真实性或生产 provider 行为；
- gate 只执行 TypeScript target，Python compatibility 由现有 pytest/共享 fixture继续证明；
- 没有 live/shadow、真实模型多 trial、LLM judge、统计显著性或 CI artifact retention；
- 没有 auth/RLS、用户内容 consent/retention 或 Memory 指标。

## 结论

组件迁移现在具备统一、只读、可阻断的 Eval gate。它把既有 fixture 变成正式的 suite/run/score 协议，但不能替代后续 workflow/e2e、live/shadow 和 Memory Eval。
