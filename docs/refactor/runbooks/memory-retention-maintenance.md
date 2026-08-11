# Memory Retention Maintenance Runbook

## 适用范围

本runbook用于独立Memory retention进程。它清理到期的user-authored source signal、candidate、active Memory和revision正文，并保留content-free tombstone。它不运行模型、不消费Redis队列，也不替代数据库备份或合规审计。

## 上线前检查

1. 先执行受控Drizzle migration，并确认存在`memory_source_signals_retention_idx`、`memories_due_idx`和`memory_candidates_due_idx`。
2. 在secret manager/control plane先创建独立login role与密码，再由admin连接运行`memory-retention-role:provision`。不要复用浏览器/API、Worker、Eval或migration连接。
3. 只配置数据库、worker identity、批次和轮询参数；不要向该进程注入Anthropic/Tavily key或Redis URL。
4. 初次上线先用只读SQL统计due inventory，并据此设置batch、alert threshold和副本数。

```sql
select count(*) from memory_source_signals where retention_until <= clock_timestamp();
select count(*) from memories where expires_at <= clock_timestamp();
select count(*) from memory_candidates where expires_at <= clock_timestamp();
```

## 启动

```bash
DATABASE_ADMIN_URL=postgresql://migration-admin:...@.../vibe_writer \
MEMORY_RETENTION_DATABASE_ROLE=vibe_writer_memory_retention \
pnpm --filter @vibe-writer/db memory-retention-role:provision

DATABASE_MEMORY_RETENTION_URL=postgresql://vibe_writer_memory_retention:...@.../vibe_writer \
MEMORY_RETENTION_DATABASE_ROLE=vibe_writer_memory_retention \
pnpm --filter @vibe-writer/db memory-retention-role:verify

MEMORY_RETENTION_MAINTENANCE_ENABLED=true \
DATABASE_MEMORY_RETENTION_URL=postgresql://vibe_writer_memory_retention:...@.../vibe_writer \
MEMORY_RETENTION_DATABASE_ROLE=vibe_writer_memory_retention \
MEMORY_RETENTION_WORKER_ID=memory-retention-1 \
MEMORY_RETENTION_BATCH_SIZE=100 \
MEMORY_RETENTION_POLL_MS=60000 \
MEMORY_RETENTION_BACKLOG_POLL_MS=250 \
MEMORY_RETENTION_BACKLOG_ALERT_THRESHOLD=1000 \
MEMORY_RETENTION_HEALTH_PORT=3201 \
pnpm start:memory-retention
```

角色契约使用`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS NOREPLICATION`。`BYPASSRLS`仅用于跨workspace扫描；实际能力仍由精确table权限收口，不能向该角色追加通用CRUD、sequence、schema CREATE或role membership。两个tombstone表的`SELECT`用于`ON CONFLICT DO NOTHING`冲突探测，due表的`UPDATE`用于`SELECT FOR UPDATE SKIP LOCKED`。

进程不会读取`DATABASE_URL`作为fallback。`/live`表示进程存活；`/ready`只有在current-connection角色verifier与数据库schema检查均完成后返回200。权限漂移、角色名不符或错误使用owner连接都会在ready前失败；backlog alert不会把readiness变为503。

## 观察与告警

非idle批次输出JSON：

- `status=progress`：本批有删除且backlog低于阈值；
- `status=backlog_alert`：剩余due总样本达到阈值或任一表达到采样cap；
- `deleted.*`：本批删除的source signal、Memory和candidate数；
- `remaining.*`：清理后仍到期的有界样本；
- `durationMs`：本批应用侧耗时。

连续`backlog_alert`时先确认数据库健康和lock等待，再增加batch或副本。不要把poll调成0或用无界delete。多个副本依靠`SKIP LOCKED`分工，副本数仍应受数据库连接和写放大约束。

## 故障处理

- schema incomplete：停止进程，完成migration，再重启；
- role verification failed：停止进程，从`DATABASE_MEMORY_RETENTION_URL`确认current user，再由admin重新provision并verify；不要临时改用owner URL；
- batch error：检查结构化error与数据库连接，进程会按正常poll重试；
- 某批进程崩溃：当前事务回滚，其他实例或下一轮继续；
- source signal cleanup成功、generic cleanup前崩溃：source-owned内容已安全删除，其余到期数据由下一轮继续；
- 大量tombstone写入：确认原因均为`retention_elapsed`，不要为降写入量跳过tombstone。

## 停止与回滚

SIGTERM/SIGINT会先进入draining、停止loop，再关闭数据库和health server。关闭进程不会恢复已删除数据。若必须临时停用，应安排受控手工执行同一repository能力并持续检查due count，不能让retention deadline无限延期。

本地角色canary使用`pnpm test:memory-retention-role:local`。它只允许连接带随机安全标记的一次性loopback PostgreSQL，创建独立role后通过真实进程启动路径清理两个workspace，并证明该角色不能读取`jobs`。
