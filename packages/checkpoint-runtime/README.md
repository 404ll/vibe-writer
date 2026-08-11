# @vibe-writer/checkpoint-runtime

PostgresSaver infrastructure adapter。它把 LangGraph checkpoint envelope 放进独立 PostgreSQL schema，并用 `@vibe-writer/db` 的 checkpoint attempt/pointer 协议约束当前 run。

核心边界：

- `workflow-runtime` 只接收 `BaseCheckpointSaver`，不依赖本包；
- 每个 run 使用独立物理 checkpoint `thread_id`，顶层 namespace 为空；
- wrapper 强制 storage scope，写入前后校验 lease；
- root checkpoint 写入成功后才 fenced 推进业务 pointer；
- fork 复制 checkpoint metadata 与 pending writes；
- checkpoint 不等于长期 memory，完整 prompt/transcript 默认不保存。

官方 saver `setup()` 只能由部署管理身份显式执行，不能放在job热路径或长期运行consumer启动路径：

```bash
DATABASE_CHECKPOINT_ADMIN_URL=postgresql://migration-role:...@postgres/vibe_writer \
pnpm setup:checkpoint-schema
```

该命令可重复执行并只输出content-free状态。完成setup后再provision/verify consumer角色；consumer只有`langgraph_checkpoint` schema `USAGE`和fenced saver所需DML，没有`CREATE`、migration ledger权限或checkpoint `DELETE`。
