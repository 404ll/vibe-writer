# Iteration 0066：单用户 Consumer 主体作用域

- 日期：2026-08-11
- 状态：In progress

## 问题

Vercel Preview可以创建Job，Outbox也能投递到BullMQ，但托管PostgreSQL上的`single-workspace` Consumer在领取Job时被`jobs` RLS拒绝。连接只固定了`app.workspace_id`，没有满足更新策略对`app.principal_id`的要求。

## 本次范围

- 单用户Consumer配置同时要求workspace与principal UUID。
- readiness同时验证两项数据库会话设置。
- 更新环境变量示例、Worker说明、Vercel运行手册和系统设计。
- 用同一个真实Preview任务继续端到端验收，避免重复模型调用。

## 验证

尚未完成。只有相关测试、Preview重新部署、服务器Worker就绪以及真实任务生成全部通过后，才能标记为`Done`。
