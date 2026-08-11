# ADR-0035：Versioned Model Grader 与 Hard Cost Budget

- 状态：Accepted
- 日期：2026-08-07

## 背景

Iteration 0033 已把 owner-approved production article 变成 retention-bound、默认 draft 的 user-content suite，但仍没有可执行的主观质量 grader。直接把某个模型调用塞进 Eval Worker 会留下四个工程缺口：rubric/judge/pricing 漂移无法复现，模型返回可以偷偷决定最终分数，失败调用的花费不可查询，以及批量 trial 可能越过成本上限。

## 决定

1. 在 `packages/eval-graders` 建立 provider-neutral grader。它只依赖 `TextModel` port、Eval runner 和 Zod，不依赖 Anthropic SDK、BullMQ 或数据库；Anthropic wire adapter 只在 `apps/eval` composition layer 注入。
2. 首个 rubric 固定为 `article-quality@2026-08-07-v1`，包含 `focus_and_intent`、`coherence`、`substantive_coverage`、`evidence_discipline`、`readability` 五项。grader 输出只允许 criterion key、0–100 整数分和 machine-readable reason code；最终加权分、最低单项门槛和 pass/fail 由本地代码计算，模型不能直接宣布通过。
3. live article dataset 当前没有原始 writing task 或 expected answer，所以 rubric 只评价文章本身可观察的质量，不声称测量原始指令遵循。若未来 materializer 经再次治理携带 task context，必须提升 materializer、case schema 和 rubric version。
4. 每个 queued run 的 execution snapshot 固定 model profile、prompt、grader、rubric、pricing、budget、graph 和 code revision；Worker 当前配置与快照不一致时拒绝执行。pricing 不使用代码中的“当前价格”，必须由部署显式提供带版本的 input/output/cache rate。
5. 每个 run 使用共享 `EvalModelBudget`。调用前按 UTF-8 input bytes 和 max output tokens 做保守预留；超出 max calls 或 max micro-USD 时不调用 provider。响应必须包含 usage，settlement 超额或无法计量后把预算标为 uncertain，后续调用 fail closed。
6. provider/model/request id、四类 token、micro-USD cost、pricing version 与 currency 作为 `eval_scores` 的结构化列持久化；rubric criterion、budget snapshot 和 failure reason 保留在有大小上限的 metadata。成功和已产生 usage 的 evaluator error 都可记录计量。
7. live grader 使用独立 Eval queue target `live-article-quality@v1`，只接受 workspace-owned、active、fingerprint/retention 仍有效的 materialized suite。target 返回被批准的 article 供 evaluator 使用，但 `captureOutput=false`，结果树不再复制文章正文。
8. grader 默认关闭。只有显式 `EVAL_GRADER_ENABLED=true` 且 API key、model/profile/prompt、pricing、per-run budget 全部存在时，registry 才注册该 target。manual enqueue 要求调用方同时提供 suite identity、dataset fingerprint、idempotency key 和 trials。

## 结果与限制

模型评分现在具有可重放 identity、严格输出契约、可查询成本和 provider-call 前的硬预算边界；Eval Worker 仍与写作任务解耦。loopback 测试经过真实 Anthropic HTTP adapter 形状和真实 Redis/BullMQ durable path，但没有使用付费外部模型，因此只证明工程协议，不证明 rubric 的 judge agreement、文章质量判别力或实际供应商价格正确。pricing snapshot 必须由部署负责人依据当时合同/官方价格审核后版本化提供。

当前预算是单 Worker、单 run 内存对象，依赖 Eval runner 顺序执行 evaluator；尚不支持同一 run 的并行 grader reservation、跨进程共享预算或 workspace 日/月配额。后续并行化前必须把 reservation ledger 提升为数据库原子账本。
