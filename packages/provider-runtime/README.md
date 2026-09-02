# @vibe-writer/provider-runtime 供应商运行时

外部人工智能、搜索与公开网页提取的基础设施适配器。目前把 Anthropic 消息接口，以及 Tavily、Brave Search、SearXNG 搜索接口映射为 `@vibe-writer/model-runtime` 与 `@vibe-writer/agent-core` 定义的供应商无关接口；公开网页正文由本地 Readability adapter 提取。

## 边界

- 负责网络请求、超时与中止、响应解析、用量、供应商请求/响应标识和错误归一化。
- 网页提取负责 URL/DNS/redirect 公网校验、连接地址固定、content-type 与响应/正文预算；外部正文始终作为不可信输入交给 Agent。
- 不负责提示词策略、工作流路由、数据库重试或业务幂等。
- 不直接写 PostgreSQL；生产工作进程在适配器外包一层外部调用账本。
- 不把提示词、模型正文或搜索内容写进日志元数据。

核心实现位于 `src/anthropic.ts`、`src/tavily.ts`、`src/brave.ts`、`src/searxng.ts` 与 `src/safe-web-extract.ts`；`src/request-lookup.ts` 定义可选的供应商请求结果查询边界。新增供应商时应实现既有接口，而不是让智能体核心分支判断供应商。

`AnthropicModel.thinkingMode`会映射为Anthropic请求体的`thinking.type`。它必须由部署配置显式决定，适合DeepSeek V4这类默认开启推理、但结构化Writer/Reviewer希望关闭推理的兼容接口；适配器不会根据model名称偷偷切换行为。

```bash
pnpm --filter @vibe-writer/provider-runtime test
pnpm --filter @vibe-writer/provider-runtime typecheck
```
