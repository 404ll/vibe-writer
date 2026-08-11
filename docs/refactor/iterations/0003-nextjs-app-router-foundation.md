# Iteration 0003：Next.js App Router 基础迁移

- 状态：Done
- 日期：2026-08-07
- 对应阶段：R2 Next.js Web

## 目标

在 `apps/web` 内把 Vite/React Router 入口迁到 Next.js App Router，同时继续请求现有 FastAPI，保持写作工作台、文章详情、编辑、历史版本和 SSE 行为。

## 范围内

- 建立 `app/layout.tsx`、`app/page.tsx` 和 `app/articles/[id]/page.tsx`；
- 将现有工作台状态编排提取为明确的 Client Component；
- 用 Next navigation 替换 React Router；
- 保留 `@vibe-writer/contracts` 和当前 `/api` 协议；
- 配置开发期 FastAPI rewrite/proxy；
- Mermaid 保持客户端动态加载，避免进入服务端路径；
- 迁移 Vitest 环境并增加路由/渲染相关测试；
- 更新根命令和当前架构文档。

## 范围外

- 不迁移 FastAPI endpoint 到 Route Handler；
- 不实现 Worker/PostgreSQL/Redis；
- 不做视觉重设计；
- 不改变 SSE event semantics；
- 不顺手修复与迁移无关的既有 lint 问题，除非它们直接阻止 Next 构建。

## 进入条件

- Iteration 0001/0002 已完成；
- 当前 Web 测试和 build 有通过基线；
- API/SSE fixture 和 runtime manifest 已入库。

## 实施内容

- 删除 Vite/React Router 入口，建立 `app/layout.tsx`、`app/page.tsx`、`app/articles/[id]/page.tsx` 和 route loading UI；
- 将原 `App.tsx` 提取为 `WritingWorkspace` Client Component，导航统一改用 Next navigation；
- 文章动态 route 在 Server Component 中从 FastAPI 读取首屏数据，并用 `ArticleDetailSchema` 做运行时校验；编辑、历史版本和下载继续留在 Client Component；
- `next.config.ts` 通过同源 `/api/:path*` rewrite 保持旧 FastAPI wire contract，workspace contracts 通过 `transpilePackages` 使用；
- active job storage 改为 `vibe-writer:active-job:v1` 最小指针，兼容读取旧 key，并使用 `useSyncExternalStore` 避免预渲染期间访问浏览器 API；
- Mermaid 从静态 import 改为仅在渲染图表时动态加载；
- Vitest 与 Next 并存，新增根路由、路由生成、storage、文章编辑和 Mermaid 动态加载测试；
- ESLint 改用 Next.js Core Web Vitals/TypeScript flat config，并忽略旧 Vite 和 Next 构建产物。

## 验证

```bash
pnpm test:web
pnpm lint:web
pnpm build:web
pnpm test:contracts
pnpm typecheck:contracts
git diff --check
```

结果：

- `pnpm test:web`：通过，6 个测试文件、12 个测试；覆盖 App Router 根页面、文章编辑保存、Mermaid 动态 import、active job 恢复指针和现有 SSE stream/replay；
- `pnpm lint:web`：通过，无 error/warning；
- `pnpm build:web`：Next.js 16.3.0 production build 通过，`/` 为静态 route，`/articles/[id]` 为动态 server route；
- `pnpm test:contracts`：通过，2 个测试文件、11 个测试；
- `pnpm typecheck:contracts`：通过；
- `git diff --check`：通过；
- production runtime：临时启动 FastAPI `127.0.0.1:8000` 与 Next `127.0.0.1:4317` 后，`/` 返回 `200 text/html` 且包含工作台，`/articles/runtime-check` 返回 `200 text/html` 且服务端输出“文章不存在”，`/api/articles` 返回 `200 application/json`；FastAPI 日志确认收到 `GET /articles/runtime-check` 和 `GET /articles`。

## 验证中发现并修正

- 首次 build 因保留空的 `src/pages/` 被 Next 同时识别为 Pages Router 而失败；将文章组件移入 `src/components/` 并删除旧目录后通过；
- 首次 runtime 使用非默认 API 端口但只在 `next start` 时注入环境变量，rewrite 仍使用 build 时写入的默认端口；因此明确 `API_PROXY_TARGET` 是 production build 配置，并按默认 `8000` 完成真实验证；
- Next ESLint 首次扫描了旧 `dist/` 产物并产生大量第三方告警；加入生成目录 ignore 后，修正 HistoryPanel effect 与 SSE callback ref 的三处真实源码问题，lint 全绿；
- 复核路线图时发现文章首屏仍由 Client effect 读取，不满足 Server-first 退出条件；最终提升到 Server Component，并保留 route loading 和客户端编辑边界。

## 退出条件

- Vite、React Router 入口和依赖已移除，Next App Router 成为唯一 Web 入口；
- 主页、动态文章页、文章编辑、Mermaid 和 SSE 均有测试或 production runtime 证据；
- FastAPI API/SSE contract 未改变，共享 contracts 测试继续通过；
- Web test、lint、build 和 diff check 通过。

以上条件均已有当前验证证据，Iteration 0003 完成。

## 遗留风险

- `/api` rewrite 是迁移期兼容层；production 的 `API_PROXY_TARGET` 需要在 `next build` 时可用，部署方案必须在 R3 前明确；
- 文章首屏已 server-first，但工作台、SSE 和历史列表仍是 Client Component，这是当前交互需求，不代表未来 API 必须留在客户端；
- 本迭代验证了现有 SSE hook 和真实 HTTP proxy，没有执行会调用付费模型的完整写作 E2E；durable execution 切换前仍需固定的无模型集成路径；
- FastAPI `JobStore`、SQLite 和文件输出仍不支持多实例或进程重启恢复，下一阶段必须先建立 PostgreSQL job/event/outbox 真相。
