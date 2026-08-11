# @vibe-writer/model-runtime 模型运行时

供应商无关的模型调用接口。智能体核心只认识这里的 `TextModel`、`ToolModel`、统一响应、用量和 `ModelRuntimeError`，不直接依赖 Anthropic 或 LangChain 开发工具包。

本包负责稳定的调用语义与 JSON 宽容解析工具；`@vibe-writer/provider-runtime` 负责真实网络请求适配器；工作进程的 `effect-journal.ts` 再负责数据库预留、用量/延迟元数据和结果不确定状态。三层分开后，切换模型供应商不会改写智能体领域逻辑，也不会让供应商开发工具包类型进入检查点状态。

```bash
pnpm test:model-runtime
pnpm typecheck:model-runtime
```
