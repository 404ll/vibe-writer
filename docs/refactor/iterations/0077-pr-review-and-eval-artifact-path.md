# Iteration 0077：PR Review 与 Eval Artifact 路径修正

> 状态：In progress
> 日期：2026-09-01

## 目标

修复 PR #2 暴露的两处测试不确定性，并让 GitHub Actions 从仓库根目录正确上传 content-free Eval artifact。

## 范围内

- 对多次 run 的状态断言显式按 `attempt` 排序，避免依赖数据库未承诺的隐式行顺序；
- legacy `outline_ready` 回放 fixture 只更新目标事件，避免 fixture 扩展后批量写入同一幂等键；
- GitHub Actions 通过 `EVAL_CI_ARTIFACT_DIR` 把产物写入 `${{ github.workspace }}/output/eval-ci`，与上传步骤保持同一绝对位置。

## 范围外

- 不修改大纲恢复的生产逻辑；
- 不修改 Eval artifact 内容、baseline 或 retention 策略；
- 不修改 Vercel 配置或部署边界。

## 验证

- `pnpm --filter @vibe-writer/db exec vitest run tests/commands.integration.test.ts tests/terminals.integration.test.ts`：通过，2 files / 13 tests；
- `pnpm typecheck:db`：通过；
- 使用绝对 `EVAL_CI_ARTIFACT_DIR` 运行 `pnpm eval:ci:artifact`：通过，目标目录生成 `eval-summary.json`；
- `pnpm check:docs`、`git diff --check`：通过；
- GitHub-hosted artifact upload：待本分支 push 后验证。

## 剩余风险

- Vercel Preview 的失败原因仍需对应 Team 下的部署日志确认，本迭代不推测或修改该问题。
