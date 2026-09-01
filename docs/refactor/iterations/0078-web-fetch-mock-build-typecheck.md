# Iteration 0078：Web Fetch Mock 构建类型修正

> 状态：Done
> 日期：2026-09-01

## 目标

修复 Vercel Preview 在 `next build` 类型检查阶段暴露的 `jobs.test.ts` mock 参数推断错误，同时保留测试对实际请求参数的断言。

## 范围内

- 为 `createJob` 测试中的成功响应 mock 显式声明浏览器 `fetch` 函数签名；
- 验证 Web 测试、TypeScript 检查和 production build。

## 范围外

- 不排除测试文件或降低 TypeScript 严格度；
- 不修改 `createJob` 生产逻辑、Vercel 配置或部署边界；
- 不处理实时日志或 Planner 风格传递。

## 验证

- `pnpm --filter @vibe-writer/web exec tsc --noEmit`：通过；
- `pnpm test:web`：通过，24 files / 78 tests；
- `pnpm build:web`：通过，包含 production TypeScript 检查与静态页面生成；
- `pnpm check:docs`：通过，219 个 Markdown 文件的相对链接均有效；
- `git diff --check`：通过。

## 剩余风险

- 本地验证完成后，仍需由 PR 的新一轮 Vercel Preview 证明远端构建环境通过。
