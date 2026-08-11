# ADR-0043：Provenance-aware Memory Extraction Calibration

- 状态：Accepted
- 日期：2026-08-07

## 背景

Memory extraction 已有 trusted envelope、独立队列和 fenced provider effect，但“从什么文本提取长期记忆”仍没有可信边界。source run 的 topic 是本次任务指令，terminal article 是 assistant/model 生成结果；如果把两者直接交给模型并允许写入长期 Memory，系统会把一次性要求或模型自己的文字误认成用户稳定偏好。

仅用 prompt 文案要求“不要误写”不够。来源作者与作用域必须由 runtime 先判定并作为可信结构传入，质量门禁还必须单独测量 should-write 决策、slot 提取和高风险泄漏。

## 决定

1. extractor prompt 输入固定为 versioned trusted segment：`id/author(user|assistant|system)/scope(durable|task|unknown)/text`。模型不能自己决定作者或把 unknown/task 升级为 durable。
2. 只有 `author=user` 且 `scope=durable` 的明确未来偏好、约束或纠正可产生 candidate。assistant/system、task-only、unknown、第三方引语、含糊或矛盾文本都必须返回空数组；敏感属性不得由模型推断或写入。
3. prompt `durable-user-memory-extractor@2026-08-07-v1` 固定字符预算和 strict JSON output。provider-neutral adapter必须显式注入`sourceBuilder`，并沿用 ADR-0042 的unknown-outcome fail-closed与usage metering。
4. 当前 completed article source builder 将topic标为`user/task`，article标为`assistant/task`，因此其合法结果是零candidate。不得为了“让Memory有数据”把二者重标为durable。
5. 建立24-case synthetic bilingual dataset：10个durable positive，14个task/assistant/sensitive/ambiguous negative。tracked gate同时约束dataset fingerprint、case inventory、逐案例slot结果、should-write precision/recall/accuracy、invalid output以及三类leak count。
6. reference target只验证dataset、runner、scorer与baseline wiring，不能证明任何真实provider/model达到生产质量。真实模型必须以新的target identity运行相同suite并经过人工复核与付费calibration。
7. production Memory consumer保持关闭，直到产品建立可审计的user-authored durable signal来源（显式“记住”动作、偏好设置或等价consent flow），并完成真实模型质量与hard cost budget门禁。

## 结果与限制

本决策把“文字是谁写的、只对本任务还是长期有效”从模型推断提升为runtime trust boundary，避免assistant article自我强化成用户画像。它也明确暴露了当前数据缺口：现有写作链路没有可信的durable user segment，所以版本化adapter存在并不等于可以启用生产提取。

synthetic reference baseline是确定性的工程回归证据，不是统计显著的模型benchmark，也不覆盖真实分布、对抗性多段对话、跨语言归一化、cost或retrieval uplift。下一轮必须先设计durable signal persistence与consent/erasure传播，再接真实provider calibration。
