# ADR-0037：Versioned Memory Policy Kernel

- 状态：Accepted
- 日期：2026-08-07

## 背景

长期 Memory 会把模型从一次性推理扩展为跨任务状态。如果 extractor、Worker 或 repository 各自判断“什么值得记、什么是重复、什么是冲突”，系统会出现不可复现写入、敏感推断自动沉淀、workspace 串写和 schema 漂移。直接先建 `memories` 表只能把这些问题持久化，不能解决它们。

## 决定

1. 新建纯 TypeScript `packages/memory-core`，先固定 Memory proposal 和 policy decision，再允许数据库与 Worker 接入。该包不依赖 DB、LangGraph、queue、model runtime 或 vector vendor。
2. proposal schema version 1 必须包含 workspace、typed subject、stable memory key、kind、content、proposer、confidence、sensitivity、consent、source run/evidence fingerprint、extractor identity 和 expiry。unknown field 直接拒绝。
3. workspace 是授权边界；`subject.kind + subject.key + memoryKey` 只是 workspace 内的 slot。active memory 与 proposal 不属于同一 slot 时不能比较，防止调用方把跨 workspace/subject 记录误判为 duplicate。
4. content 使用 NFKC、trim 和 whitespace collapse 生成 1–4096 字符的 normalized value，再计算 SHA-256。规范化只用于短结构化 Memory，不适用于文章、消息或知识 chunk。
5. policy `2026-08-07-v1` 将 proposal 分为 `candidate`、`duplicate`、`conflict` 或 `rejected`。同 slot、同 fingerprint 是 duplicate；同 slot、不同 fingerprint 是 conflict，不允许 last-write-wins。
6. model-proposed sensitive inference 一律拒绝；model confidence 低于 0.8 或 proposal 已到期也拒绝。user-proposed sensitive content可以进入 candidate，但仍需后续明确 review/retention policy，不能由 core 自动批准。
7. core 不返回“approved”或直接写 memory。candidate 审批、冲突替换、revision、evidence、硬删除、RLS 和 retrieval 由后续 repository/runtime 实现，并必须消费此 policy decision。

## 结果与限制

Memory 写入前已有可版本化、确定性、可单测的治理边界，精确重放和冲突不会被混为一谈。当前没有语义去重、实体解析、敏感信息分类模型、数据库、API、embedding 或 retrieval；NFKC/空白归一化只能识别形式重复，不能宣称解决语义同义或事实矛盾。
