# ADR-0061：TypeScript 重构 MVP 范围冻结

- 状态：Accepted
- 日期：2026-08-10

## 背景

项目已经完成Next.js Web、TypeScript Agent/Workflow、PostgreSQL durable execution、BullMQ Worker、staging API、Memory治理和持续Eval基础，并通过多轮真实PostgreSQL/Redis/Next canary。继续拆分synthetic publisher、migration、运维查询等数据库角色，或提前建设付费calibration、retrieval/pgvector和完整production平台，会显著增加维护面，但不再决定MVP能否验证核心产品价值。

用户明确将目标校准为“完成MVP即可”，不是构造一个完备平台。因此需要冻结工程范围，避免以扩展性名义继续添加当前没有产品反馈驱动的基础设施。

## 决定

1. 当前MVP以“本地/受控staging可运行、核心行为可恢复且可回归”为完成标准：
   - Next.js App Router承载Web；
   - TypeScript Agent组件和LangGraph.js workflow可执行；
   - PostgreSQL、BullMQ、Worker、checkpoint、outbox和terminal article形成durable主链路；
   - Next durable API/SSE、取消、outline resume、failure和lease takeover有契约或集成证据；
   - Memory具备显式consent、管理、删除和确定性Eval基础；
   - Eval具备versioned dataset、component/workflow gate、独立queue和受治理live candidate基础。
2. Python/FastAPI暂时保留为兼容与回滚基线。MVP不要求在没有真实流量切换证据时删除旧路径。
3. 以下内容从MVP移到production hardening/backlog：真实Auth/Ingress与公开切流、目标云部署、所有控制面数据库角色细分、migration/ops角色、付费judge/Memory calibration、pgvector/RAG、托管observability、P95/P99容量和故障演练。
4. Iteration 0059之后停止继续拆分数据库职责。已开始的workspace Eval operator实现撤回；只保留发现的namespace-scoped测试断言修正。
5. 后续迭代必须由实际用户反馈、明确上线阻塞或可量化Eval退化触发。不得仅因为架构图中“还可以更完整”就增加组件。

## 结果与限制

MVP可以用于产品验证和受控staging，不等于production readiness。公开流量仍不能绕过真实身份代理、目标环境secret/network验证和切流Runbook。Memory模型调用、retrieval和付费Eval仍保持默认关闭。

这一冻结减少当前维护成本，同时保留已有contracts、ports、versioned execution和Eval数据面作为未来扩展缝隙。恢复production hardening时，应从真实阻塞重新排序，而不是机械继续旧路线图。

## 回滚

若用户验证明确要求production上线或某项被延期能力，应新增ADR/iteration解除相应冻结，并给出产品证据、最小实现和退出条件；不原地把本ADR改写为“从未冻结”。
