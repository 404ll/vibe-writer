# Iteration 0066：单用户 Consumer 主体作用域

- 日期：2026-08-11
- 状态：Done

## 问题

Vercel Preview可以创建Job，Outbox也能投递到BullMQ，但托管PostgreSQL上的`single-workspace` Consumer在领取Job时被`jobs` RLS拒绝。连接只固定了`app.workspace_id`，没有满足更新策略对`app.principal_id`的要求。

## 本次范围

- 单用户Consumer配置同时要求workspace与principal UUID。
- readiness同时验证两项数据库会话设置。
- 更新环境变量示例、Worker说明、Vercel运行手册和系统设计。
- 用同一个真实Preview任务继续端到端验收，避免重复模型调用。

## 验证

- `@vibe-writer/worker`测试`92`项通过，typecheck通过；
- 服务器Worker同时加载固定workspace与principal，`/ready`返回`ready`；
- 真实Preview任务`520ae891-bd5e-4ccf-a842-c0403a520f6a`成功从`waiting_outline`继续执行到`completed/export`，没有再触发`jobs` RLS错误；
- 任务只生成一条outline reply command，证明验收期间没有因网络重试重复提交；
- 任务最终生成Article `a35ae592-7f4d-4222-a2b6-22bc25ab5d93`。

退出条件已经满足，本轮标记为`Done`。
