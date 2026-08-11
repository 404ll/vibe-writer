# ADR-0044：Explicit User-authored Memory Source Signals

- 状态：Accepted
- 日期：2026-08-07

## 背景

ADR-0043规定只有runtime可信标注的`user + durable`文本可以进入长期Memory提取，但当前业务数据只有task-scoped topic与assistant-generated article。现有`memory_candidates`和`memory_extraction_tasks`都以completed run为唯一source，无法表达用户独立提交的“请记住”、偏好设置或长期纠正。

直接把job topic重标为durable会混淆一次性任务与长期授权；直接扩展candidate或task又会在没有可信source生命周期前引入悬空外键和删除传播缺口。

## 决定

1. 新增独立`memory_source_signals`，表示用户通过明确产品动作提交的durable source。它不从普通对话、task topic或assistant article自动生成。
2. signal固定记录workspace、作者principal、可选author-owned source run、idempotency key/request fingerprint、source kind、target subject、原始用户文本、evidence fingerprint、`explicit_user` consent policy和database-time retention deadline。
3. principal subject只能指向作者本人。viewer可以提交自己的personal signal；workspace/project subject至少需要editor。即使owner也不能冒充另一principal创建user-authored signal。
4. 可选source run必须同时属于当前workspace并由signal作者创建，避免跨workspace或代他人引用run作为证据。
5. 创建采用`workspace + author + idempotency key`唯一键；完全相同的request replay返回原row，不同request复用key显式collision。
6. 作者可删除自己的signal，workspace owner可执行治理删除，其他成员无权删除。删除和retention expiry都硬删除source text，仅保留`memory_source_signal_tombstones`中的source id、workspace、actor/reason/time，不保留text、subject、fingerprint或consent细节。
7. signal与tombstone启用workspace RLS。repository所有用户路径设置transaction-local workspace/principal session；真实PostgreSQL非owner role必须证明跨workspace和无scope读取为空。
8. 本轮不扩展`memory_extraction_tasks`或`memory_candidates`的source identity，也不发outbox。source union、derived candidate删除传播和production API/consumer必须在后续ADR中完成。

## 结果与限制

系统现在有了真实、可审计、可撤回的durable user source，而不必从模型产物推断用户画像。独立表让source consent/retention先成为稳定事实，再扩展收费extraction ledger。

当前signal仍是staging data capability：没有HTTP/UI入口、没有extraction outbox、没有source-signal keyed attempt/effect，也没有candidate/revision对signal的外键。因此不能宣称用户提交后会自动产生Memory，production consumer继续保持关闭。
