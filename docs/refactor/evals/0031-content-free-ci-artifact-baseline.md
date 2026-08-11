# Eval 0031：Content-free CI Artifact 本地基线

- 日期：2026-08-07
- 结论：Passed locally; GitHub-hosted retention not evaluated
- 对应迭代：[0035](../iterations/0035-content-free-ci-eval-artifact.md)

## Contract

| 项目 | 值 |
|---|---|
| artifact schema | `1` |
| suites | component regression + workflow shadow |
| content fields | prohibited |
| baseline mutation | prohibited |
| identity | code revision + CI run id + attempt |
| integrity | SHA-256 over payload without digest field |
| local path | `output/eval-ci/eval-summary.json` |
| CI retention | 30 days |

## 本地结果

| 指标 | 实际 |
|---|---:|
| component cases/trials | 38 / 38 |
| workflow cases/trials | 3 / 3 |
| target errors | 0 |
| evaluator errors | 0 |
| baseline failures | 0 |
| artifact bytes | 3,811 |

fixture 主动在 input、expected、output 和 evaluator metadata 放入四个不同 secret marker；序列化 artifact 不包含任何 marker，也没有 `trials` 字段。artifact 保留 suite dataset fingerprint、target execution versions、baseline identity 和 metric aggregate，因此可以回答“什么代码、什么数据集、什么实现、对比哪个 baseline、结果如何”，但不能还原单个 case 内容。

根级门禁通过 TypeScript 388 项、Python 50 项，共 438 项；component 38/38、workflow shadow 3/3、Web lint/test/build、migration check 和 114 个 Markdown 链接均通过。DB suite 限制为 4 个 Vitest worker 后 83/83 通过，避免 CI 长链中的 PGlite 初始化资源争抢，同时保留 10 秒 hook timeout。

## 未证明

- 没有真实 GitHub Actions run、artifact URL、server digest、下载复核或 30 天 expiry；
- 没有测试 fork PR、cancelled job、upload outage 或 artifact quota；
- 没有 live model grader、cost 或 user-content summary；
- local hash 含 generated timestamp，不用于跨 run 判等；跨 run 比较应使用内部 suite/dataset/execution identity 和 metrics。
