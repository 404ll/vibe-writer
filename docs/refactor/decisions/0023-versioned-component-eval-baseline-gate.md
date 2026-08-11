# ADR-0023：版本化组件 Eval Baseline 与只读回归门禁

- 状态：Accepted
- 日期：2026-08-07

## 背景

Iteration 0021 建立了通用离线 runner 和 Eval 数据模型，但迁移 fixture 仍分散在 contracts/Agent 测试与 Markdown 记录里。`pnpm verify` 能证明单项断言通过，却不能给出统一的 suite identity、dataset fingerprint、case inventory、target version 和 pass-rate baseline，也不能阻止 fixture 被增删后只更新测试而没有更新评测决策。

自动重写 baseline 会把实现错误吸收成“新正常”；把每个代码 revision 写进 baseline 又会导致任何重构都必须更新金标，失去回归门禁价值。

## 决定

1. 新增 `@vibe-writer/eval-cli`，把 Planner outline/trim、JSON tolerance、Reviewer、Coverage、Search policy/ranking 和 Writer tool loop 的现有合成 fixture 统一转换为一个 38-case component suite。
2. suite identity 固定为 key + version；dataset fingerprint 覆盖规范化 input、expected 和 tags；case key 包含原 dataset id、组件组和 fixture id。
3. target 执行真实 TypeScript component，而不是复制预期值。唯一 grader `canonical-exact-match@v1` 对 canonical JSON fingerprint 做确定性比较。
4. tracked baseline 固定 suite/target version、dataset fingerprint、完整 case inventory、trial 数量、最大 target/evaluator error 和每个 metric 的 score count/pass-rate 门槛。
5. `pnpm eval:components` 只读取 baseline 并比较，不写文件、不访问数据库、不调用外部 provider；它进入根级 `pnpm verify`。
6. `pnpm eval:components:baseline` 只向 stdout 打印候选 baseline。failed report 或包含 target/evaluator error 的 report 不能生成 baseline；接受变更必须人工审查并用 `apply_patch`/正常代码评审更新版本化文件。
7. dataset/case inventory 变化必须提升 suite version，并创建新的 baseline 文件；不得原地覆盖历史版本来绕过 gate。
8. 每次 report 的 `codeRevision` 是 agent/model/contracts/eval runner/component suite 相关源码 SHA-256，留作运行归因；baseline 不锁死 code revision，避免把所有内部实现变化都当作契约变更。
9. `register` 子命令只有在显式提供 `EVAL_DATABASE_URL` 和 `EVAL_NAMESPACE_KEY` 时才写 PostgreSQL。它不运行 migration，不打印 URL，并将 fixture 标记为 synthetic。

## 不变量

- baseline manifest 必须通过运行时校验，不能缺 case inventory、metric gate 或合法 fingerprint。
- 当前 gate 必须有 38 个唯一 case、38 个 score、0 target error、0 evaluator error 和 100% exact match。
- fixture 内容和 scripted secret 不进入默认 Eval report；PostgreSQL registration 只保存明确标记的 synthetic suite。
- 同一 namespace/suite/version 注册两次只保留一个 suite/case 集合，但每次执行生成独立 run/trial/score 历史。
- baseline 变化必须是显式评审动作，不能由 `verify` 自动修改工作树。

## 明确限制

- 当前 gate 只覆盖确定性迁移行为，不评测文章质量、引用正确性、真实搜索结果或 Memory。
- Python compatibility 仍由共享 fixture pytest 约束；本 gate 评测 TypeScript target，不启动 Python 作为 shadow target。
- 没有跨 commit 的统计显著性、多 trial LLM judge、CI artifact 上传或 baseline promotion 服务。
- 还没有 production user-content dataset、retention/consent 或 auth/RLS。

## 未选择

- 用普通 unit-test 计数代替 Eval baseline：缺少统一 dataset/target identity 和可持久化 report。
- 失败时自动更新 baseline：会把回归合法化。
- baseline 固定源码 SHA：会让无行为变化的重构产生无意义更新。
- gate 直接连接 Langfuse：会使 CI 正确性依赖外部服务。
