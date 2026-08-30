# 前端开发 Agent 规范

这份文档适用于 `apps/web/` 下的前端开发任务。

## 技术栈与边界

- Next.js App Router + React + TypeScript。
- 路由：`app/` 文件系统路由和 Next navigation。
- 实时通信：`fetch + ReadableStream` / SSE。
- 内容渲染：react-markdown、remark-gfm、Mermaid。
- 包管理：pnpm workspace，包名 `@vibe-writer/web`。

## 目录约定

- `app/`：Server Component 页面和路由入口，只负责路由与接线。
- `src/components/ui/`：跨业务可复用展示组件，例如 Markdown/Mermaid。
- `src/components/writing/`：写作工作台业务组件与任务状态编排。
- `src/components/articles/`：文章阅读、编辑和历史版本。
- `src/components/memory/`：Memory 管理业务组件。
- `src/hooks/`：浏览器 hooks；SSE 订阅集中在 `useJobStream.ts`。
- `src/lib/`：浏览器侧工具层。`lib/api` 是调用 `app/api` 的 HTTP client；另有配置、路由辅助、SSE 常量和本地恢复指针。
- `src/types/`：前端共享视图类型。
- `src/server/`：Route Handler / RSC 用的服务端模块，按 `database`、`http`、`identity`、`jobs`、`articles`、`memory` 分子目录。
- `src/styles/`、`src/assets/`、`src/testing/`：样式、静态资源和测试脚手架。
- 跨目录 import 使用 `@/`（指向 `src/`）。

## 开发规则

- 保持“AI 写作工作台”体验，不把页面改成 landing page 或营销页。
- 不做无关视觉重设计；UI 改动应服务当前任务。
- 浏览器 API 请求优先集中在 `src/lib/api/`，Server Component 查询放在 `src/server/`；不要在组件里复制复杂 fetch 逻辑，也不要把 client 放进 `app/api`。
- SSE 行为优先集中在 `useJobStream.ts`；不要在多个组件里各自建立 EventSource。
- 默认保持 Server Component；只在交互、浏览器 API、SSE 或 Mermaid 边界使用 Client Component。
- localStorage 只保存版本化、最小化的恢复指针，不作为任务事实来源。
- 修改 Markdown/Mermaid 渲染时要注意安全边界，不引入不受控 HTML 注入。
- 保持 TypeScript 类型清晰，不用 `any` 逃避类型问题，除非局部兼容第三方库并说明原因。

## 常用命令

从仓库根目录：

```bash
pnpm dev:web
pnpm build:web
pnpm test:web
pnpm lint:web
```

只运行前端包命令：

```bash
pnpm --filter @vibe-writer/web test
pnpm --filter @vibe-writer/web build
```

## 验证状态

- `pnpm build:web` 当前可通过。
- `pnpm test:web` 当前可通过。
- `pnpm lint:web` 当前可通过。
- 前端变更完成时，优先运行相关 Vitest；涉及编译或类型时运行 `pnpm build:web`。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
