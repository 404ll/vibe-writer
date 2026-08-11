# ADR-0039：Deterministic Memory Governance Eval

- 状态：Accepted
- 日期：2026-08-07

## 背景

Memory policy 和持久化 repository 已有单元/集成测试，但后续 extractor prompt、模型、review API 和 retrieval 会跨 package 演进。若没有稳定 dataset identity、target version 和 tracked baseline，规则变化只能靠测试文件是否变绿判断，无法与其他 Agent/Eval 门禁使用同一套报告协议，也无法明确区分“有意更新 policy”与“意外改变写入语义”。

同时，candidate/conflict 的 review transition 原先在 repository 内以条件分支实现。未来出现多个写入入口时，这部分很容易漂移，尤其是 stale candidate、错误 replacement id、kind mismatch 和 revision increment。

## 决定

1. `@vibe-writer/memory-core` 新增 provider/persistence-neutral `planMemoryReviewTransition()`。它只接受 policy outcome、kind、content fingerprint、可选 active Memory revision 和显式 replacement id，返回 `create revision 1`、`replace revision N+1` 或结构化 rejection。
2. durable repository 必须执行该 transition plan；它仍负责锁、RLS、数据库时钟、compare-and-swap、revision insert 和 candidate event，但不能复制 review decision table。
3. 新建独立 `memory-governance-regression@2026-08-07-v1` synthetic suite，覆盖 proposal eligibility、normalization、duplicate、conflict、privacy rejection、expiry、schema/slot failure，以及 create/stale/explicit replace/kind/revision transition。
4. suite 使用自有 `@vibe-writer/eval-core` offline runner、稳定 case key、dataset fingerprint、target identity 和 tracked baseline。报告默认不 capture output；proposal 内容只存在于版本控制内的 synthetic case，不写入 run report。
5. 根级 `pnpm verify` 必须运行 `pnpm eval:memory`。dataset、policy 或 expected behavior 改变时，baseline fingerprint 必须显式评审更新，不能静默接受新结果。
6. 该 suite 只证明 deterministic governance。真实 extractor 的 should-write precision/recall、敏感分类、语义冲突、retrieval 和 answer uplift 必须使用独立 dataset/metric，不能用 18 个规则 case 替代。

## 结果与限制

Memory 的 pre-persistence policy 和 review transition 现在使用同一 versioned core 与 Eval 报告协议，repository drift 会同时被 integration test 和 baseline gate 捕获。suite 完全不调用模型，因此快速、免费、可在每次 CI 运行；相应地，它不提供任何 extractor 或 retrieval 质量证据。
