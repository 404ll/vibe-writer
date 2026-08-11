# ADR-0041：Independent Memory Extraction Delivery

- 状态：Accepted
- 日期：2026-08-07

## 背景

Memory extraction 发生在写作 run 完成之后，不应延长 terminal transaction，也不能依赖 HTTP/Next.js 进程。若 terminal 提交文章后再 best-effort enqueue，会出现文章已完成但永远没有 extraction request 的双写窗口；若复用写作队列，Memory backlog、并发和重试又会与用户主任务互相干扰。

## 决定

1. `completeClaim()` 在 article、done event、job/run completed 的同一 PostgreSQL transaction 中写入 `memory_extraction/memory.extraction.requested` outbox。payload 只能是匹配 aggregate id 的 `{runId}`，不得包含文章、topic、proposal 或 consent。
2. Memory 使用独立 BullMQ queue，job name为 `extract.memory`，versioned payload为 `{schemaVersion:1, runId}`，稳定 queue job id为 `memory-{runId}`。写作队列和 Memory 队列可以独立扩缩容、暂停和配置 retry。
3. consumer 通过 service repository按 run pointer读取 completed source。若 current article 已编辑，读取 revision 0 snapshot；因此 extraction 输入对应 terminal 时的文章，而不是消费时的可变 current draft。
4. retention expiry 以稳定的 run `finishedAt` 为 anchor。不能使用每次消费时的当前时间，否则相同 delivery retry 会产生不同 proposal identity并触发 collision。
5. Worker 用 trusted-envelope contract合成 proposal，再逐项调用幂等 repository。队列重放可能再次执行 scripted extractor，但 candidate unique identity使结果收敛；policy rejected内容不落库，successful candidate保持 `pending_review`，绝不自动 materialize。
6. 当前只允许 scripted extractor验证 delivery correctness。真实收费模型接入前必须增加 extraction effect/attempt ledger或等价的 provider-call fencing、固定 prompt/model/cost identity和 should-write Eval，不能直接把 production Anthropic adapter接到此消费者。

## 结果与限制

completed run 到 Memory candidate 已有无双写窗口的 durable request、pointer-only Redis delivery、独立 queue 和可重放 consumer。真实 Redis 与 PostgreSQL都已验证。当前 production composition 尚未启用 Memory consumer；outbox会形成可观察 backlog，直到后续配置明确启用。逐项 submission不是单事务 batch，但任何中途失败可依靠稳定 extractor identity幂等重放并最终收敛；若未来需要 all-or-nothing batch，再新增 repository transaction而不是在 Worker补偿删除。

后续进展：[ADR-0042](./0042-fenced-memory-extraction-effects.md)已用独立task/attempt/effect账本替代“在任何中途失败后重新执行extractor”的假设。provider effect一旦可能开始，未知结果必须fail closed，不能只依赖candidate幂等键重复调用收费模型。
