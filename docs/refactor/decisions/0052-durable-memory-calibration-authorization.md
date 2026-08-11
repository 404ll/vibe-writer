# ADR-0052：Durable Memory Calibration Authorization

- 状态：Accepted
- 日期：2026-08-09

## 背景

ADR-0051已经把Memory calibration约束为dataset、model、prompt、pricing与budget的不可变binding，但approval仍只存在于调用方提供的JSON中。进程内approval无法证明谁在何时批准，也无法在Worker重启、重复enqueue或多workspace环境中保持唯一事实来源；若另建Memory专用队列，又会复制已有Eval run、outbox、lease、report与fencing语义。

## 决定

1. PostgreSQL新增`memory_calibration_authorizations`作为付费校准的业务授权对象，保存workspace、synthetic suite、strict binding snapshot/fingerprint、未含approval的base execution snapshot、target、trials、creator与状态。
2. 状态只允许`draft -> approved -> enqueued`。审批只允许workspace owner，并由数据库时间生成approval evidence；审批必须携带预期binding fingerprint和reason code，任何漂移都拒绝。
3. `memory_calibration_authorization_events`记录`created | approved | enqueued`顺序事件。应用角色只有SELECT/INSERT RLS policy，没有UPDATE/DELETE policy；事件不保存prompt、model output、credential或用户正文。
4. enqueue锁定authorization并在同一数据库事务创建现有`eval_runs` queued request、`eval.run.requested` outbox、authorization状态和审计事件。BullMQ继续只携带Eval run UUID，不创建Memory calibration side queue。
5. Worker target registry增加`memory-extraction-live-calibration@v1`。executor必须从PostgreSQL按run id读取enqueued authorization，重算binding fingerprint，并逐项核对workspace、suite、dataset和execution snapshot后才调用provider-neutral runner。
6. Worker中的Anthropic composition默认关闭。只有显式`EVAL_MEMORY_CALIBRATION_ENABLED=true`并提供独立API key/model配置时才注册executor；model仍必须与已审批binding一致。preflight/registration/approval/enqueue命令本身不调用provider。
7. 真实model选择、官方pricing snapshot、最高费用和发起付费运行仍是一次独立的operator决策。本ADR不授权任何具体model或费用。

## 结果与限制

approval现在是workspace-owned、RLS隔离、可重放且可审计的数据库事实；重复注册、审批和enqueue有明确collision语义，queue重用现有claim/heartbeat/report fencing。PGlite证明事务与幂等，真实PostgreSQL证明跨workspace RLS，scripted 72-trial executor证明queued identity检查。

本轮没有真实provider调用、账单对账或人工Go/No-Go结果。authorization事件对普通应用role append-only；数据库owner仍属于受信运维边界。同步Anthropic Messages缺少request-level terminal lookup，因此provider调用出现unknown outcome时仍不能自动重试或自动解除production No-Go。

## 回滚

可以关闭`EVAL_MEMORY_CALIBRATION_ENABLED`并停止注册该executor；未消费的queued run会保持可审计状态。若回滚schema，必须先保留authorization/event/run关联的审计导出，不能退回由环境变量或临时JSON单独授权付费调用。
