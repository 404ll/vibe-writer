# 前端开发 Agent 规范

这份文档适用于 `apps/web/` 下的前端开发任务。

## 技术栈与边界

- React + TypeScript + Vite。
- 路由：React Router。
- 实时通信：EventSource / SSE。
- 内容渲染：react-markdown、remark-gfm、Mermaid。
- 包管理：pnpm workspace，包名 `@vibe-writer/web`。

## 目录约定

- `src/App.tsx`：主工作台页面和任务状态编排。
- `src/pages/ArticlePage.tsx`：文章阅读、编辑、历史版本和下载。
- `src/components/`：可复用 UI 组件。
- `src/hooks/useJobStream.ts`：SSE 订阅、历史事件回放和去重。
- `src/api.ts`：文章 API client。
- `src/config.ts`：API base 配置。

## 开发规则

- 保持“AI 写作工作台”体验，不把页面改成 landing page 或营销页。
- 不做无关视觉重设计；UI 改动应服务当前任务。
- API 请求优先集中在 `src/api.ts`；不要在组件里复制复杂 fetch 逻辑。
- SSE 行为优先集中在 `useJobStream.ts`；不要在多个组件里各自建立 EventSource。
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

## 验证与既有失败

- `pnpm build:web` 当前可通过。
- `pnpm test:web` 当前可通过。
- `pnpm lint:web` 当前存在既有 lint 错误。
- 如果任务不是修 lint，不要为了让 lint 全绿而改无关文件。
- 前端变更完成时，优先运行相关 Vitest；涉及编译或类型时运行 `pnpm build:web`。

