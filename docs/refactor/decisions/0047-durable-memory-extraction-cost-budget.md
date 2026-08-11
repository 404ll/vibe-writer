# ADR-0047：Durable Memory Extraction Cost Budget

- 状态：Accepted
- 日期：2026-08-07

## 背景

Memory extraction已有provider effect reservation和usage/cost metadata，但“记录费用”不等于“限制费用”。BullMQ consumer可多实例并发，进程内计数无法阻止两个Worker同时越过workspace日预算；只在provider响应后检查也已经产生外部费用。另一方面，unknown outcome可能已经计费，不能因为本地没有usage就释放额度并自动重试。

## 决定

1. 在`memory-core`定义严格、版本化的budget policy与pricing snapshot：source总上限、workspace UTC日上限、max output tokens和四类token费率。计算层不依赖DB、queue或provider SDK。
2. 调用前按实际versioned prompt的UTF-8 bytes和max output tokens计算最大预留。由于provider对cache token可能采用替代或附加计数，input、cache-read、cache-write三类最高费用均纳入保守预留；实际settlement释放差额。
3. budget policy进入extraction execution snapshot和fingerprint。budget启用时，extractor暴露的max output tokens必须完全一致；prompt version不一致也在provider调用前失败。
4. effect row保存UTC budget day、policy/pricing version、最大预留、source cap和workspace daily cap。预算字段是content-free metadata，不保存prompt、source正文或model output。
5. `reserveEffect()`先锁task，再锁workspace row，并在同一PostgreSQL事务内汇总当天workspace和该source的计费/占额。这样多个Worker session不能双花同一日额度。
6. `reserved`与`uncertain`按最大预留占额；`succeeded`按实际cost占额；known `failed`且无计费metadata释放预留。workspace当天已存在的policy、daily cap或pricing version发生漂移时fail closed。
7. budget rejection不创建effect、不调用provider，task/attempt以稳定budget reason终结。budgeted success必须包含usage，由Worker按pricing snapshot计算cost；usage缺失、实际费用超过预留或pricing不匹配都转入`uncertain`/reconciliation边界。

## 结果与限制

hard budget成为PostgreSQL-owned并发不变量，而不是单Worker最佳努力。source retry共享总额度，workspace所有run/signal extraction共享UTC日额度；unknown费用继续占额，避免用重复收费换取自动收敛。

当前budget policy仍由受控Worker配置提供，没有workspace管理API、时区自定义、预警阈值或运营dashboard。`uncertain`预留不会自动释放；必须由后续resolver取得供应商账单/结果证据后再决定。

## Migration 与回滚

migration只为effect增加nullable budget metadata与索引/check，历史非预算effect保持合法。启用budget前必须先部署读写schema的consumer；回滚前必须停止budget producer，并确认没有依赖reserved/uncertain占额的运行中调用。删除这些列会丢失费用上限证据，因此不能在未导出审计记录时直接回滚。
