# @vibe-writer/model-runtime

供应商无关的模型调用边界。Agent core 只认识这里的 `TextModel`、`ToolModel`、统一响应与 `ModelRuntimeError`，不直接依赖 Anthropic、LangChain 或其他 provider SDK。

当前只定义 port、tool message block 和 JSON tolerance utility；真实 provider adapter、重试、timeout、usage 上报与 trace 在后续迭代实现。
