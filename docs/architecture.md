# vibe-writer 架构入口

> 状态：当前架构索引。最后核对：2026-08-07。

vibe-writer 已把 Web 从 React/Vite 迁到 Next.js App Router，正在继续把 FastAPI/Python Agent 迁到 TypeScript Worker。完整目标、边界和迁移约束统一维护在 [重构系统设计](./refactor/system-design.md)；本文件只提供当前入口，避免历史设计继续被误认为现状。

## 当前实现

```text
apps/web   Next.js 16 App Router + React 19
    │
    ├── Server Component：文章首屏读取和 Zod 校验
    ├── Client Component：任务交互、编辑、历史版本和 Mermaid
    └── fetch + ReadableStream：SSE 实时事件和历史回放
            │
            │ /api rewrite 与服务端查询
            ▼
apps/api   FastAPI + asyncio + LangGraph Python
    ├── plan → write → review → export
    ├── JobStore：进程内任务、回复、取消和事件历史
    └── SQLite：文章和文章版本
```

Next.js 当前不承载长任务；它负责页面、同源代理和浏览器交互，写作 workflow 仍全部在 FastAPI/Python 中运行。当前工作流是分阶段 LangGraph 状态图，不是多个自治 Agent 互相协商。

## 当前 TypeScript Durable MVP

```text
Next.js Web/API
    │
    ├── PostgreSQL：Job、Run、事件、checkpoint、Article和版本
    ├── Redis/BullMQ：写作任务异步投递、并发和重试
    ├── Node Worker：LangGraph.js 写作长任务
    └── Eval：版本化component/workflow回归门禁
```

Memory相关schema、API和测试作为默认关闭的归档实验模块保留，不属于当前产品MVP、启动依赖或架构心智模型。

## 权威文档

- [重构文档中心](./refactor/README.md)
- [系统设计](./refactor/system-design.md)
- [技术路线图](./refactor/roadmap.md)
- [ADR 决策记录](./refactor/decisions/)
- [迭代日志](./refactor/iteration-log.md)

`docs/superpowers/` 下的文件和 [2026-04 评测报告](./evaluation-report-2026-04.md) 是历史材料，只能用来解释演进过程，不能单独证明当前行为。
