# @vibe-writer/agent-core 智能体核心

纯 TypeScript 写作领域组件。它回答“如何规划、研究、写作和审稿”，不回答“请求从哪来、任务由谁领取、状态存在哪、具体调用哪家开发工具包”。

## 组件

| 文件 | 角色 |
|---|---|
| `src/planner.ts` | 生成或修改文章大纲 |
| `src/coverage.ts` | 把章节目标拆成需要覆盖的要点 |
| `src/research.ts` | 通过供应商无关的 `SearchProvider` 获取资料 |
| `src/writer.ts` | 逐章写作并使用有界工具循环 |
| `src/reviewer.ts` | 章节与全文质量检查 |
| `src/tool-loop.ts` | 限制工具轮数、解析严格工具数据结构、累计预算 |
| `src/prompts.ts` / `src/versions.ts` | 可审查提示词与显式版本 |

这些组件只依赖 `@vibe-writer/contracts` 和 `@vibe-writer/model-runtime` 接口。测试与评测可以注入脚本化模型和搜索服务；生产环境由工作进程的 `workflow-services.ts` 注入 Anthropic/Tavily 适配器，并在外层增加外部调用账本。

保持这一层纯净的代价是需要额外适配器和组合代码；收益是智能体行为可以脱离 Next.js、BullMQ、PostgreSQL 和付费供应商做快速回归。

```bash
pnpm test:agent-core
pnpm typecheck:agent-core
```
