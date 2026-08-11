# Iteration 0022：组件 Eval Baseline Gate

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0023](../decisions/0023-versioned-component-eval-baseline-gate.md)
- 评测记录：[Eval 0018](../evals/0018-component-regression-gate-baseline.md)

## 目标

把既有迁移 fixture 从分散测试提升为可执行、可持久化、可在 CI 阻断回归的统一 Eval suite，同时保持 baseline 更新显式、报告默认不包含正文、gate 不依赖数据库或外部平台。

## 范围内

- 为 eval-core 增加 report summary、baseline manifest、运行时校验和 compare；
- 建立 38-case TypeScript component regression suite；
- 建立 tracked baseline 与只读 `pnpm eval:components`；
- 把 Eval gate 纳入根级 `pnpm verify`；
- 提供 report、候选 baseline 和 PostgreSQL register 命令；
- 使用相关源码 SHA-256 作为每次 run 的 code revision；
- 真实 PostgreSQL 连续注册两次并核对幂等 suite 与独立 run 历史；
- 更新系统设计、路线图、ADR、迭代和 Eval 证据。

## 范围外

- 不更新或重解释 Python compatibility verdict；
- 不引入真实模型、LLM judge、搜索网络或用户文章；
- 不自动写 baseline，不上传 CI artifact；
- 不实现 shadow queue、Memory Eval、auth/workspace/RLS；
- 不改变产品流量或执行真实数据迁移。

## Suite 组成

| 来源 | 组件 | Case |
|---|---|---:|
| `agent-component-baseline-v1` | Planner outline/trim、JSON、Reviewer | 19 |
| `opinion-search-baseline-v1` | Coverage、Search policy/ranking | 11 |
| `writer-tool-baseline-v1` | Writer tool loop | 8 |
| 合计 | 7 个组件组 | 38 |

所有 case 使用稳定 key，target 运行真实 component API。exact-match grader 比较 canonical fingerprint，不受 object key 顺序影响。

## Baseline 流程

```text
contracts fixtures
  → component suite adapter
  → @vibe-writer/eval-core runner
  → content-free report
  → tracked baseline compare
  → pass / CI non-zero exit
```

`baseline` 命令只打印候选 JSON；manifest 缺字段、case inventory/fingerprint 变化、error 增加、score 数变化或 pass-rate 下降都会使 `check` 失败。接受数据集变化时必须提升 suite version 并新增 baseline 文件。

## PostgreSQL 注册

`register` 要求显式 DB URL 与 namespace。真实 PostgreSQL harness 连续运行两次后核对：

- 1 个 idempotent suite；
- 38 个 synthetic case；
- 2 个 completed eval run；
- 76 个 succeeded trial；
- 76 个 succeeded/passed score。

## 验证

- `pnpm test:eval-core`：3 个文件、8 项通过；
- `pnpm test:eval-cli`：2 个文件、3 项通过；
- `pnpm typecheck:eval-core`、`pnpm typecheck:eval-cli`：通过；
- `pnpm eval:components`：38/38 exact match，0 target/evaluator error；
- `pnpm test:db:postgres:local`：真实 DB 9、PostgresSaver 4、两次 Eval registration 与 SQL cardinality gate通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 327 项、Python 50 项，共 377 项测试通过；Web lint/build、全部 typecheck、migration check 与组件 gate 通过；
- `pnpm check:docs`：75 个 Markdown 文件链接通过；
- `git diff --check`：通过。

## 退出条件核对

1. fixture 形成统一 versioned suite：满足。
2. baseline 能阻断 dataset/case/score/error/pass-rate 回归：满足。
3. baseline 更新不会由 verify 自动发生：满足。
4. report 默认不含 fixture output/secret：满足。
5. suite 可写入自有 PostgreSQL 且重复注册幂等：满足。
6. live/shadow、主观质量和 Memory Eval：未满足，明确留到后续迭代。

## 回滚

从 `verify` 移除 gate 和删除 `apps/eval` 不改变产品运行时，但会失去统一 regression evidence；数据库中已注册的 suite/run 是历史记录，不应随代码回滚直接删除。eval-core baseline helper 无数据库副作用，可独立撤回。

## 后续

1. CI 保存 content-free report artifact，并与选定 baseline run id关联；
2. 增加 workflow/e2e suite 和 Python/TS shadow compare；
3. 接独立 Eval queue、真实模型 profile 与固定 rubric；
4. auth/workspace 后把 namespace 绑定强外键/RLS；
5. Memory 实现后复用同一 gate 增加 isolation/retrieval/answer-gain suite。
