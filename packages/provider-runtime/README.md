# @vibe-writer/provider-runtime 供应商运行时

外部人工智能与搜索服务的基础设施适配器。目前把 Anthropic 消息接口和 Tavily 搜索接口映射为 `@vibe-writer/model-runtime` 与 `@vibe-writer/agent-core` 定义的供应商无关接口。

## 边界

- 负责网络请求、超时与中止、响应解析、用量、供应商请求/响应标识和错误归一化。
- 不负责提示词策略、工作流路由、数据库重试或业务幂等。
- 不直接写 PostgreSQL；生产工作进程在适配器外包一层外部调用账本。
- 不把提示词、模型正文或搜索内容写进日志元数据。

核心实现位于 `src/anthropic.ts`、`src/tavily.ts`；`src/request-lookup.ts` 定义可选的供应商请求结果查询边界。新增供应商时应实现既有接口，而不是让智能体核心分支判断供应商。

```bash
pnpm --filter @vibe-writer/provider-runtime test
pnpm --filter @vibe-writer/provider-runtime typecheck
```
