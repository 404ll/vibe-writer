# ADR-0032：Live Eval Candidate Governance

- 状态：Accepted
- 日期：2026-08-07

## 背景

独立 Eval queue 已能安全执行注册过的 synthetic suite，但线上回灌会接触真实 workspace 内容。若 sampler 直接复制 article、prompt 或 trace payload 到 `eval_cases`，用户内容会绕过 consent、retention、删除传播和人工审查，Eval 数据集也会变成新的长期副本。

在 grader 和自动回归之前，系统需要先回答“这次 production run 是否允许成为候选、由谁批准、何时过期、来源是否变化”。

## 决定

1. 新增独立 `eval_candidates` ledger；candidate 只保存 workspace/job/run/article pointer、revision、content fingerprint、sampler identity、采样桶、consent policy、classification、retention 和状态，不保存 topic、article、prompt、message 或 model output。
2. sampler 只查询 completed job/run 的最小身份字段与 article id/revision/fingerprint，数据库查询本身不加载正文。
3. 采样桶由 `workspace + sourceRun + sampler key/version` 确定性计算，范围为 0–9999；同一 sampler version 的 policy/source identity 不可变，变化必须提升 version，否则 collision fail closed。
4. 没有 `workspace_policy` 或 `explicit_user` consent 时不创建 candidate；consent policy version 和未来 retention deadline 必填。
5. candidate 状态仅为 `pending_review → approved | rejected | expired`。本轮不提供 materialize 转换，approved 也不等于已进入 Eval dataset。
6. review 需要 verified workspace editor/owner scope，reason 只能是 machine-readable code；viewer 无权审批。candidate 与 append-only governance event 同事务更新。
7. 过期操作使用数据库时间、row lock 和 `SKIP LOCKED`，可由多个 maintenance worker 并发运行；过期后不可恢复审批。
8. candidate/event 启用 workspace RLS；删除 source job/article/workspace 会级联清理 pointer ledger。非 owner API role 的无 scope/跨 workspace 查询必须为空。

## 结果与限制

该设计把“是否允许进入评测”与“如何执行评测”分开，为 future de-identification/materialization、grader 和 memory Eval 提供审计入口，也避免 approved 前复制用户正文。

当前 consent 是可信 service 调用方提供的 policy assertion，还没有 consent policy 表、公开 API、自动 production scanner、de-identification worker、case materializer 或 deletion tombstone/export。approved candidate 仍只是 pointer；任何读取正文并生成 Eval case 的后续步骤必须新增 ADR、权限和 retention 证据。
