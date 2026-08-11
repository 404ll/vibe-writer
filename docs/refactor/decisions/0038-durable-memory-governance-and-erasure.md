# ADR-0038：Durable Memory Governance、Revision 与 Erasure

- 状态：Accepted
- 日期：2026-08-07

## 背景

ADR-0037 固定了 Memory proposal 和 policy decision，但没有决定候选如何落库、谁可以审核、冲突如何替换、来源删除如何传播，以及保留期结束后正文是否真的消失。若只建立一张可直接更新的 `memories` 表，模型提取、人工确认和删除会共享同一写入口，最终退化为不可审计的 last-write-wins。

## 决定

1. PostgreSQL 是长期 Memory 的唯一业务真相。`memory_candidates` 保存通过 policy 的待审核提案，`memories` 保存 workspace 内当前 slot，`memory_revisions` 保存每次人工确认的不可变正文，`memory_candidate_events` 保存审核轨迹，`memory_tombstones` 只保存无正文的删除证明。
2. repository 必须调用 `@vibe-writer/memory-core`，不能重新实现 normalization、fingerprint 或 duplicate/conflict 判断。proposal 只允许引用同 workspace 的 completed run；policy rejected proposal 不落库，exact replay 复用同一 candidate，active slot 的 exact duplicate 不再制造审核项。
3. candidate 不会自动写入 active Memory。editor 或 owner 可以审核；新 slot materialize 为 revision 1。conflict 必须显式提交当前 `memoryId`，并以 compare-and-swap 推进 revision；缺少或过期的 replacement identity 一律失败，不能 last-write-wins。
4. active Memory 的读取可以开放给 workspace viewer；候选正文、候选事件和审核操作至少要求 editor。硬删除是 owner-only，因为它同时删除该 slot 的候选、事件、当前值和全部 revision。
5. retention 使用数据库时钟。到期的 candidate、Memory 和 revision执行硬删除；只为已 materialize 的 Memory 留下 `memoryId + workspaceId + slot fingerprint + reason + actor/time` tombstone，不保留 memory key、subject key 或正文。新 proposal 遇到已到期 active slot 时先完成同样的 retirement，再允许创建新 candidate。
6. `memory_candidates.source_run_id` 级联到 run；`memories.current_candidate_id` 和 `memory_revisions.source_candidate_id` 再传播删除。因此删除来源 job/run 会清除其派生的 candidate，并在当前值来自该 candidate 时清除 Memory 内容。
7. 五张表全部启用 workspace RLS。直接携带 workspace 的表使用 transaction-local `app.workspace_id`；revision 和 candidate event 通过父记录检查。公开 API 仍必须使用非 owner、无 `BYPASSRLS` 的数据库角色。
8. embedding、semantic dedupe、retrieval、prompt injection 和管理 UI 不进入本 ADR。它们只能消费已经 materialized、未到期的 revision，不能绕过 candidate/review 边界直接写 `memories`。

## 结果与限制

Memory 写入现在具有确定性 policy、幂等 candidate、显式审核、冲突替换、revision history、workspace 隔离和可验证硬删除。并发创建同一空 slot 时数据库唯一约束允许至多一个成功 materialize；另一个候选必须重新按 active slot 评估，系统不会静默覆盖。

当前 candidate 仍在其保留期内保存短正文，以便人工审核；rejected candidate 也会保留到 expiry maintenance 执行。系统尚未提供定时调度器、用户管理页面、PII 分类器、语义冲突合并或 retrieval quality 证据，因此不能把本迭代描述为完整 Memory 产品。
