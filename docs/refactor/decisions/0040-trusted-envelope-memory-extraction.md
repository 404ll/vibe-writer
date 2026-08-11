# ADR-0040：Trusted-envelope Memory Extraction

- 状态：Accepted
- 日期：2026-08-07

## 背景

下一阶段会让模型从 completed run 中提取 Memory candidate。若要求模型直接输出完整 `MemoryProposal`，它也会控制 workspace、source run、consent、extractor version、retention 和 proposer identity；即使 JSON schema 合法，这些字段也不能被视为可信。多个 candidate 在同一 batch 中占用同一 slot 还会制造顺序相关的内部冲突。

## 决定

1. 模型只输出 strict `MemoryExtractionOutput`：subject、memory key、kind、短 content、confidence 和 sensitivity。unknown field 直接拒绝，单次最多 20 项，空 batch 是合法的“没有值得记忆内容”。
2. workspace id、source run id、evidence fingerprint、extractor key/version、consent basis/policy 和 expiry 属于 trusted envelope，由 Worker/composition 从已授权配置与 durable run 构造，模型不能提供或覆盖。
3. `composeModelMemoryProposals()` 将 model fields 与 trusted envelope 合并，并再次通过 `MemoryProposalSchema`。`proposedBy` 固定为 `model`，避免模型伪装为 explicit user proposal绕过 sensitive inference policy。
4. 同一 extraction batch 内 `subject kind + subject key + memory key` 必须唯一。重复 slot 整批 fail closed，不按数组顺序选择“最后一个值”。跨 batch duplicate/conflict 继续由 versioned Memory policy 和 active store判断。
5. extraction contract 位于 provider/persistence-neutral `memory-core`。provider JSON mode、prompt、retry、source content读取、evidence计算、queue/outbox 和 repository submission 分别由后续 adapter/Worker负责。

## 结果与限制

模型输出不再是授权或数据保留事实，只是受限的非可信 candidate description。当前 contract 不会读取 run 内容、调用模型或提交 candidate；evidence fingerprint仍是整个受控输入的摘要，不是可展示的证据片段。真实 extractor 质量和 prompt injection resilience 必须通过后续 dataset/Eval 验证。
