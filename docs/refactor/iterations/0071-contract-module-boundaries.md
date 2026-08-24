# 迭代 0071：共享契约目录与模块职责拆分

- 状态：`Done`
- 日期：2026-08-24
- 关联：[系统设计](../system-design.md)、[共享契约说明](../../../packages/contracts/README.md)

## 问题

`packages/contracts` 已同时承载产品接口、SSE、Memory 和 Eval 基线。原有源码全部平铺在 `src/`；其中 `sse.ts` 把事件词表与事件载荷混在一起，`memory-management.ts` 同时包含公共枚举、活跃记忆 CRUD 和候选审核，导致读者难以从目录和导入路径判断自己依赖的协议边界。

## 本轮范围

- 按 `articles/`、`jobs/`、`memory/`、`research/`、`eval/` 和 `__tests__/` 组织源码目录；
- 将 SSE 事件名、分组和终止语义拆到 `jobs/event-types.ts`，将可持久化事件载荷与历史响应拆到 `jobs/events.ts`；
- 将 Memory 管理公共字段、活跃记忆和候选审核分别拆到 `memory/management/shared.ts`、`records.ts` 和 `candidates.ts`；
- 保留 `jobs/sse.ts` 与 `memory/management/index.ts` 作为兼容入口，不要求既有外部消费者同步迁移；
- 为新模块增加 package subpath exports，并让仓库内生产消费者使用职责更精确的导入路径；
- 为 Research 与 Memory 的信号、策略、活跃记录和候选审核补充数据流与治理语义注释；
- 保留 `jobs/commands.ts`、`articles/index.ts` 以及单类 Eval fixture 的完整职责边界，避免只按行数机械拆分。

## 边界

- 不改变任何 Zod 校验规则、字段名称、默认值或 TypeScript 推导结果；
- 不改变 Route Handler、数据库或 Worker 的运行时行为；
- 不改变 PostgreSQL schema、队列协议或部署配置；
- 本轮只是包内模块职责重排，不改变数据所有权或运行时边界，因此不新增 ADR。

## 验证

- `pnpm test:contracts`：2 个测试文件、30 项测试通过；
- `pnpm typecheck:contracts`：通过；
- `pnpm test:web`：20 个测试文件、69 项测试通过；
- `pnpm lint:web`：通过；
- `pnpm build:web`：Next.js 生产构建与 TypeScript 检查通过，新的嵌套 subpath exports 可以被真实 Route Handler 和客户端组件解析；
- `pnpm test:db`：21 个测试文件、135 项测试通过；
- `pnpm typecheck:db`：通过；
- `pnpm check:docs`：212 个 Markdown 文件的相对链接全部有效；
- `git diff --check`：通过。

## 退出条件

新子路径可以被真实消费者解析，兼容入口继续通过原有契约测试，相关 package 类型检查、测试、lint、构建和文档链接检查全部通过后，才能标记为 `Done`。

退出条件已经满足，本轮标记为 `Done`。
