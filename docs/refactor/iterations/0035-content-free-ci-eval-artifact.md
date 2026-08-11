# Iteration 0035：Content-free CI Eval Artifact

- 日期：2026-08-07
- 状态：Superseded by [ADR-0061](../decisions/0061-mvp-scope-freeze.md)
- 对应决策：[ADR-0036](../decisions/0036-content-free-ci-eval-artifacts.md)
- 评测记录：[Eval 0031](../evals/0031-content-free-ci-artifact-baseline.md)

## 目标

把 component 与 workflow shadow gate 汇总为可追溯、默认不含内容、不会自动改 baseline 的 CI artifact，并明确 retention 与失败语义。

## 已实现

- content-free artifact builder、schema version、CI identity 和 payload SHA-256；
- component/workflow tracked baseline comparison 与聚合结果；
- input/expected/output/trial/score metadata 的排除测试；
- exclusive-create CLI 与 ignored output 路径；
- pull request/push GitHub Actions workflow；
- read-only permissions、frozen install、missing artifact failure 与 30 天 retention。

## 验证

- `pnpm test:eval-cli`：局部环境 7 个文件、21 项通过、4 项跳过；新增 content-free artifact 测试通过；
- `pnpm typecheck:eval-cli`：通过；
- 本地 `pnpm eval:ci:artifact`：component 38/38、workflow shadow 3/3，artifact 3,811 bytes，payload SHA-256 为 `b11eda36251206043c9b374a6b5326f07460cdd7a040f367447e1c96212c41fc`；该 hash 只对应本次带时间戳的 local-dirty verification，不是 tracked baseline；
- GitHub workflow YAML parse、`git diff --check`：通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 388 项、Python 50 项，共 438 项通过；component 38/38、workflow shadow 3/3、Web lint/test/build、全部 typecheck/migration check 和 114 个 Markdown 链接通过；
- 根级验证首两次暴露 PGlite 13-suite 高并发初始化会撞 10 秒 hook timeout；把 DB Vitest `maxWorkers` 固定为 4 后，DB 83/83 与完整 verify 均通过，未放宽单 suite timeout；
- 真实 GitHub-hosted workflow/artifact retention：未运行。

## 退出条件

1. artifact 不包含 case input/expected/output/trial/score metadata：满足。
2. baseline regression 使 artifact status 与 CLI exit code 失败：builder/CLI 满足，CI 失败路径待远端证明。
3. artifact 绑定 code revision/run attempt 并带 payload hash：满足。
4. CI 不能自动写 tracked baseline：满足。
5. 真实 GitHub run 可下载 artifact，missing file 会失败且 retention 为 30 天：待远端证明。

## 后续

真实GitHub-hosted artifact验证已由Iteration 0060移入production backlog，不阻塞MVP，也不再作为自动推进的当前迭代。

1. 首次 push 后核对 workflow run、artifact digest/download 与失败路径；
2. 决定是否给 full `pnpm verify` 建独立 workflow，避免 Eval job 重复安装；
3. 付费 judge calibration artifact 与成本聚合必须使用另一份 schema；
4. Memory Eval artifact 必须先完成 workspace/privacy contract。
