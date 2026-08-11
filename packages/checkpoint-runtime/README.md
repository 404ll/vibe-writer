# @vibe-writer/checkpoint-runtime 检查点运行时

本包是 PostgresSaver 的基础设施适配器。它把 LangGraph 检查点封装放进独立 PostgreSQL 数据结构，并用 `@vibe-writer/db` 的检查点尝试与指针协议约束当前运行。

核心边界：

- `workflow-runtime` 只接收 `BaseCheckpointSaver`，不依赖本包；
- 每个运行使用独立物理检查点 `thread_id`，顶层命名空间为空；
- 包装器强制存储作用域，写入前后校验租约；
- 根检查点写入成功后才受隔离令牌保护地推进业务指针；
- 分叉会复制检查点元数据与待处理写入；
- 检查点不等于长期记忆，完整提示词与对话记录默认不保存。

一次恢复的顺序是：工作进程先用当前 `leaseToken` 初始化检查点尝试 → 适配器为该运行选择独立物理 `thread_id` → LangGraph 写检查点 → 适配器再次校验租约 → 最后推进业务指针。旧工作进程即使完成了一个慢写，也不能越过后置隔离校验把指针指回旧状态。

官方保存器的 `setup()` 只能由部署管理身份显式执行，不能放在任务热路径或长期运行消费者的启动路径：

```bash
DATABASE_CHECKPOINT_ADMIN_URL=<管理员数据库连接地址> \
pnpm setup:checkpoint-schema
```

该命令可重复执行并只输出不含正文的状态。完成初始化后再配置并验证消费者角色；消费者只有 `langgraph_checkpoint` 数据结构的 `USAGE` 权限和受隔离令牌保护的保存器所需数据读写权限，没有 `CREATE`、迁移记录权限或检查点 `DELETE` 权限。
