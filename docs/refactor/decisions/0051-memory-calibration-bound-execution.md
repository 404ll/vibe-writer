# ADR-0051：Memory Calibration Bound Execution

- 状态：Accepted
- 日期：2026-08-09

## 背景

ADR-0050建立了tracked calibration plan与offline No-Go readiness，但plan中的model、pricing和cost cap刻意为空。若后续直接从环境变量组装并调用provider，审批无法证明自己批准的是哪组dataset、model、prompt、pricing和预算；若只限制调用次数，不在调用前计算整套trial inventory的最大成本，也无法形成可审计的付费边界。

## 决定

1. live Memory calibration使用独立execution manifest，固定plan key、dataset fingerprint、provider、model、model profile、prompt/extractor/code revision、max output tokens、完整pricing snapshot与hard budget。
2. 对24-case、3 trials/case的每个prompt按UTF-8 bytes和最高input/cache rate保守计价，再加max output token价格。execution的`maxCalls`必须精确等于72，`maxCostMicrousd`必须精确等于preflight计算值，不能用任意更大的额度掩盖配置漂移。
3. model、pricing、budget等不可变字段生成binding fingerprint。显式approval必须包含该fingerprint、approval id、approver和UTC timestamp；任一字段修改都会使approval失效。未审批manifest只能quote/preflight，runner在任何model调用前拒绝。
4. runner只依赖provider-neutral `TextModel`，不导入provider SDK、DB或queue。真实运行时composition必须在后续通过独立durable Eval process接入，不在通用preflight CLI中放置“执行”子命令。
5. 每次response必须提供usage、HTTP request identity和response object identity，并与manifest的provider/model一致。unmetered failure使预算进入uncertain并停止后续调用；identity缺失或漂移也立即熔断，不继续消耗剩余trial预算。
6. strict JSON、finish reason和should-write/slot/leak结果作为quality evidence；无效JSON可以继续完成剩余trial，以测量稳定失败率。report使用`captureOutput=false`，只保留output fingerprint、content-free quality metadata和结构化model metering。
7. scripted runner通过quality gate也只表示执行协议可用。真实trial完成后仍需人工审查结果与账单；request-level terminal lookup缺失时，production automatic uncertain resolution继续禁用。

## 结果与限制

Memory calibration现在具备quote、immutable preflight、显式approval和provider-neutral runner contract。审批对象不再是模糊的“跑一次模型”，而是一份可重复计算的dataset/model/pricing/budget快照。

本ADR没有选择真实model或pricing，没有保存approval manifest，没有读取credentials，也没有发起外部付费调用。当前runner尚未注册为PostgreSQL-owned durable Eval target；进程故障恢复、approval持久化、账单对账和人工Go/No-Go仍属于后续迭代。

## 回滚

可移除preflight CLI和live calibration runner，同时保留ADR-0050的offline No-Go plan。不得以回滚为由允许未绑定approval的付费调用，或降低已有Eval hard-budget语义。
