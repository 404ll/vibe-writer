# ADR-0036：Content-free CI Eval Artifact

- 状态：Accepted
- 日期：2026-08-07

## 背景

component 与 workflow shadow gate 已能阻断回归，但结果只存在于 stdout，无法把某次 CI 的 code revision、execution identity、baseline comparison 和指标作为单一可下载证据保留。直接上传完整 `EvalRunReport` 又会让未来误开启的 output capture、case input 或 evaluator metadata 进入第三方 artifact storage。

## 决定

1. 建立 schema-versioned content-free artifact builder。输入可以是完整 report，但输出只保留 suite/target/execution identity、trials-per-case、baseline identity、comparison failures 和聚合指标；不序列化 case key inventory、trial、input、expected、output 或 score metadata。
2. artifact 固定 CI code revision、run id、attempt 和 generated time，并为不含 digest 字段的 canonical payload 计算 SHA-256。artifact status 是所有 gate comparison 的合取，失败报告仍可上传供诊断。
3. CLI 默认写入 ignored `output/eval-ci/eval-summary.json`，使用 exclusive create，避免同一工作目录静默覆盖前一次证据。调用方可以用 `EVAL_CI_ARTIFACT_DIR` 指向隔离目录。
4. GitHub Actions 在 pull request 与 push 上使用 Node 22、Python 3.12、frozen pnpm lock 和 pinned Python requirements 运行 component + workflow shadow artifact。权限只有 `contents: read`，不注入产品或 provider secret。
5. artifact upload 使用 `if: always()`、missing-file error 和 30 天 retention。生成失败且没有 artifact 时，upload step 也失败；baseline regression 时 CLI 先写失败 artifact 再非零退出。
6. tracked baseline 仍只能人工评审后修改；CI artifact 不生成或覆盖 baseline，不写 PostgreSQL，也不包含 live user-content Eval。

## 结果与限制

本地已经证明 artifact contract、content filtering、hash 和两个 gate 的联合生成。当前 worktree 未 push，因此没有真实 GitHub-hosted run、artifact URL、服务端 digest 或 30 天到期删除证据；Iteration 0035 在首个远端成功/失败 run 都被核对前保持 In progress。

GitHub artifact retention 只覆盖 CI 合成证据，不是 production Eval dataset 的 retention。未来若加入 live/user-content summary，必须先单独定义允许导出的字段和 workspace aggregation 阈值，不能复用 synthetic artifact 的默认许可。
