# ADR-0017：Provider Adapter 与 Worker 进程边界

- 状态：Accepted
- 日期：2026-08-07

## 背景

TS Agent/graph/lease/checkpoint/queue 已有确定性实现，但此前只有 scripted `TextModel`、`ToolModel`、`SearchProvider`，没有生产 `WorkflowServices` 装配或进程入口。进一步审计还发现：workflow 没把 article style 传给 Writer，也没把 Worker cancellation signal 传到模型/搜索调用；直接加启动脚本会制造“可启动但不可安全取消”的伪完成状态。

## 决定

1. 新增独立 `@vibe-writer/provider-runtime`。Anthropic Messages 与 Tavily Search 的 HTTP、鉴权、协议映射、timeout/abort、错误分类和响应校验止于 adapter；Agent core 不导入供应商 SDK/type。
2. Anthropic adapter 同时实现 `TextModel` 与 `ToolModel`，显式映射 text/thinking/tool_use/tool_result、stop reason、usage 和 request id。未知或非法响应失败为 `invalid_response`，不把原始 provider body写入业务错误。
3. Tavily adapter消费共享 date-bounded search contract，输出标准 documents；搜索 key 缺失时 composition 不注册 search tool，而不是构造一个假成功 provider。
4. workflow service input 全部携带同一 Worker `AbortSignal`；write input额外携带 state style。Provider timeout 与用户/lease cancellation 必须区分。
5. outline revision 是单独 versioned prompt 和 `planner.revise` operation，不再由测试-only identity function代替。
6. production composition root 固定 model/prompt/graph/tool/code revision snapshot，装配 PostgreSQL repository、PostgresSaver、BullMQ、provider 和 graph executor。
7. 同一二进制支持 `dispatcher`、`consumer`、`all` 三种角色。dispatcher 与模型 consumer 可独立扩缩容；Redis payload仍只保存 job指针，PostgreSQL 是真相。
8. `DURABLE_WORKER_ENABLED=true` 才允许启动。consumer 启动前强制校验 model key/id；所有角色强制显式 worker id、code revision、PostgreSQL 和 Redis。
9. shutdown 先停止 dispatcher loop/consumer intake，再关闭 queue client、checkpointer 和数据库；SIGTERM/SIGINT 共用幂等 close。
10. runtime不自动执行业务 Drizzle migration；部署必须先运行受控 migration。PostgresSaver只初始化自己的隔离 schema。

## 不变量

- cancellation signal到达每个真实 provider call；lease lost 后不能继续产生获授权的业务写入。
- provider secret 不进入 job、event、checkpoint、log 或错误响应。
- dispatcher 可以在没有 model credential 的独立部署中运行。
- 没有显式 enable/config 时进程 fail closed，不连接外部服务。

## 未选择

- 在 Agent core 直接使用 Anthropic/Tavily 类型：会污染 memory/eval 与第二供应商适配边界。
- Next.js 请求内运行 graph：生命周期、扩缩容和取消边界不适合长任务。
- 只有 `all` 角色：无法独立扩缩 dispatcher 和昂贵 consumer。
- 把取消只停留在 heartbeat：网络中的 provider 请求仍会继续计费和占用连接。
