# ADR-0053：Durable Memory Retention Maintenance

- 状态：Accepted
- 日期：2026-08-09

## 背景

Memory repository已经能按数据库时间删除到期的source signal、candidate和active Memory，并留下content-free tombstone；但这些方法只在测试或其他请求顺带访问时运行。没有长期进程主动调用，retention deadline不会自动收敛，数据库索引也未针对跨workspace的全局到期扫描设计。

把清理塞进写作Worker会让模型/队列负载影响合规删除；依赖部署平台的单实例cron又缺少并发claim、backlog反馈和持续排空语义。清理必须允许多实例安全扩缩容，并且不能读取provider凭据或依赖Redis。

## 决定

1. 增加独立`Memory retention maintenance`进程，只依赖PostgreSQL。它与写作Worker、Memory extraction consumer和Eval Worker分别部署、探测和扩缩容。
2. 每批先删除到期source signal，再处理active Memory与candidate。source deletion事务负责settle extraction erasure、冻结待投递outbox并级联删除source-owned内容；generic expiry不能抢先绕过这些语义。
3. repository使用`clock_timestamp()`、有界batch、稳定`(deadline, id)`顺序和`FOR UPDATE SKIP LOCKED`。多实例可以跳过其他实例已锁行；进程崩溃只会回滚当前repository事务，下一轮可安全重放。
4. 为全局扫描新增`memories(expires_at, id)`与`memory_candidates(expires_at, id)`索引；source signal已使用`(retention_until, id)`索引。workspace-leading索引继续服务产品查询，不能替代全局maintenance索引。
5. 每批产生versioned、content-free报告：删除数、有限backlog样本、是否达到采样上限、阈值和耗时。仍有due work时使用短轮询继续排空；清空后回到常规周期；达到阈值输出`backlog_alert`。
6. health readiness只表示schema和进程可工作，backlog alert不把实例标记not-ready，避免编排系统重启恰好负责排空积压的进程。batch失败会记录错误并按常规周期重试。
7. runtime默认关闭，通过独立配置和入口启动，不要求Redis、Anthropic、Tavily或代码revision。生产部署仍必须提供只允许maintenance所需表操作的专用数据库角色；当前本地验证使用一次性数据库owner，不能当作角色最小权限已经落地。

## 结果与限制

retention从被动repository能力变成可运行的独立系统组件。tombstone和extraction ledger仍是删除的durable业务证据；batch report属于运维观测，不复制正文，也不另建无限增长的maintenance run表。

source cleanup和generic cleanup是两个事务。中间崩溃不会恢复已删除正文，但第二阶段会在下一轮继续，因此是安全的at-least-once maintenance，不是跨所有表的单一大事务。当前没有接Prometheus/OTel exporter、托管告警或专用production DB role；`backlog_alert`先以结构化日志提供稳定契约。

## 回滚

关闭`MEMORY_RETENTION_MAINTENANCE_ENABLED`并停止独立进程即可回滚runtime；已生成的tombstone和已删除正文不可恢复。新增索引可保留，避免回滚期间重新引入全表扫描。不得通过回滚延长已承诺的retention deadline；进程停用时必须由受控手工批处理接管清理。
