# ADR-0033：Versioned Live Eval Sampling Policy 与 Durable Cursor

- 状态：Accepted
- 日期：2026-08-07

## 背景

Iteration 0031 只允许 service 显式提交一个 completed run 作为 candidate，尚不能持续消费 production backlog。若用无状态 cron 按时间窗口重扫，会出现重复采样、漏扫、policy 修改后历史回灌、多个实例竞争和单个空 workspace 长期占用批次的问题；若 scanner 读取正文，则还会绕过 candidate governance 的 content-free 边界。

## 决定

1. 新增 workspace-owned `eval_sampling_policies`。每个 policy 固定 sampler key/version、0–10000 basis-point sample rate、consent policy version、retention days、配置者和状态；同一 workspace/sampler key 只允许一个 active version。
2. policy 只能由 verified workspace owner 配置或禁用，并通过 workspace-scoped repository 暴露；editor/viewer 不可修改。表启用 PostgreSQL RLS，非 owner API database role 无 scope 时看不到记录。
3. scanner 使用 `(run.finished_at, run.id)` 复合 durable cursor，只按 completed job/run 顺序读取 source run/job/workspace 与 article id/revision/content fingerprint；不查询 topic、正文、prompt、message、trace payload 或 model output。
4. policy 升级创建不可变新版本并继承旧 active version 的 cursor，避免新采样率或 consent version 无意重扫历史；同 version 配置漂移 fail closed。
5. active policy 批次使用 `FOR UPDATE SKIP LOCKED`，允许多个独立 sampler 进程并发分片。`last_scanned_at` 在有无新 source 时都更新，查询按 null-first 最久未扫描顺序轮转，避免空 workspace 饥饿其他 policy。
6. candidate 创建、append-only sampled event 和 cursor/last-scan 更新在同一 PostgreSQL transaction。source 缺 article 或发生 candidate identity/policy collision 时整批回滚且 cursor 不前进。
7. sampler 是独立长生命周期进程，由 `EVAL_LIVE_SAMPLER_ENABLED=true` 显式开启；数据库是唯一进度真相。进程只轮询策略和写 candidate ledger，不调用 grader、不投递写作队列，也不 materialize 正文。

## 结果与限制

系统现在可以安全、幂等且水平扩展地把新 completed run 转成 governed pointer，重启不会丢失 cursor，多实例不会同时持有同一 policy，空 workspace 也不会阻塞全局扫描。

当前 policy 尚无公开 API/UI、健康检查、backlog metric 或 consent 撤回 resolver；scanner 使用受信 service database role 绕过 workspace RLS 做跨 workspace maintenance。approved candidate 仍不是 Eval case，去标识化、正文读取、materialization、grader 和删除传播必须由后续独立协议实现。
