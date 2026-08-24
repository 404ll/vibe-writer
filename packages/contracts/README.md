# @vibe-writer/contracts 共享契约

网页端、工作进程、工作流与评测共享的运行时协议。这里使用 Zod 同时定义“TypeScript 类型”和“运行时真正接受的数据”，防止不同进程只在编译期看起来一致。

## 负责与不负责

- 负责网页接口消息体、服务端推送事件、智能体输入输出和版本化固定样例的数据形状。
- 不负责数据库结构、业务执行、网络请求或向后兼容策略本身。
- 契约变化会同时影响生产运行时和评测，不能只修改单侧消费者。

## 核心契约

```text
src/
├── articles/          # 文章 CRUD 与历史版本
├── jobs/              # 任务命令、事件词表与事件载荷
├── memory/            # Memory 信号、策略与管理接口
│   └── management/    # 公共字段、活跃记录与候选审核
├── research/          # 供应商无关的检索协议
├── eval/              # 版本化 Eval/回归 fixture Schema
├── __tests__/         # 契约与 fixture 验证
└── index.ts           # 公共总入口
```

目录调整不破坏既有的 `/jobs`、`/sse`、`/articles` 和 `/memory-management` 导入；
需要更窄依赖的新代码可使用 `/jobs/events`、`/jobs/event-types` 或
`/memory/management/*` 子路径。

| 文件 | 消费者 | 含义 |
|---|---|---|
| `src/jobs/commands.ts` | 网页端、数据库、工作进程 | 创建任务、人工大纲回复与工作流阶段 |
| `src/jobs/event-types.ts` | 网页端、服务端推送 | 事件名、前端分组与终止事件语义 |
| `src/jobs/events.ts` | 数据库、网页端、工作进程 | 每种事件的 payload 与可按 `_seq` 重放的历史响应 |
| `src/jobs/sse.ts` | 既有消费者 | 兼容入口，汇总上述两类 SSE 契约 |
| `src/articles/index.ts` | 网页端、数据库 | 文章、版本与恢复接口 |
| `src/research/index.ts` | 智能体、供应商适配器 | 搜索结果的供应商无关形状 |
| `src/memory/management/shared.ts` | Memory Route Handler | 分页、枚举与原因码 |
| `src/memory/management/records.ts` | Memory 页面、数据库 | 已生效记忆的列表与删除 |
| `src/memory/management/candidates.ts` | Memory 页面、数据库 | 候选记忆、审核与事件记录 |
| `src/memory/management/index.ts` | 既有消费者 | Memory 管理兼容入口 |
| `src/eval/*-fixtures.ts` | 测试、评测 | 固定历史行为和失败/恢复投影 |

`_seq` 在组件级事件里可以缺省，因为节点刚产生事件时还没进入数据库；数据仓储持久化后必须分配单调递增序号，服务端推送和前端才用它恢复与去重。

修改契约时应同步检查：数据结构是否严格、所有生产消费者是否升级、固定样例与基线是否需要显式版本变化，以及旧持久化数据是否仍可解析。

```bash
pnpm test:contracts
pnpm typecheck:contracts
```
