# ADR-0002：Next.js 与 Agent Worker 分离运行

- 状态：Accepted
- 日期：2026-08-07

## 背景

写作任务可能持续数分钟，也可能在大纲确认处等待用户输入。HTTP Route Handler 具有请求生命周期和部署时长限制，不能承担 durable background execution。

## 决定

Next.js 负责 Web、HTTP/SSE API 和管理界面；独立 Node Worker 负责 LangGraph.js、工具、memory 和 eval。两者共享 TypeScript packages，但独立部署和扩缩容。

## 结果

- 需要 PostgreSQL 和队列协调两个运行时；
- 本地开发至少包含 Web、Worker、PostgreSQL，进入队列阶段后还包含 Redis；
- Agent core 不能导入 Next.js API；
- Worker 崩溃和重启成为必须测试的正常场景。

## 未选择

- 在 `POST /api/jobs` 返回后继续执行 Promise：无法保证跨部署持续运行。
- 让 SSE 请求本身承载完整写作：浏览器断开会错误地影响业务生命周期。
