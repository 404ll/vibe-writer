# TypeScript Durable 发布与回滚 Runbook

> 当前只有Next.js Web/API + TypeScript Worker + PostgreSQL/BullMQ产品路径。FastAPI/Python与SQLite fallback已经退役。

## 本地验证

```bash
pnpm dev:durable
pnpm test:durable-product:local
pnpm dev:durable:down
```

本地模式使用loopback PostgreSQL/Redis和只在development生效的固定身份，不得复制到公开环境。

## 部署拓扑

```text
Vercel Preview
  Next.js pages + Route Handlers + SSE
             │
             ▼
      external PostgreSQL
          ▲          ▲
          │          │
   dispatcher      consumer
          └─ BullMQ / Redis ─┘
             external Node Worker
```

Vercel不运行常驻BullMQ Worker。Preview配置和部署顺序见[专用runbook](./vercel-preview.md)。

## 发布门禁

- Vercel Preview已开启Vercel Authentication；
- Web使用非owner、无`BYPASSRLS`的`DATABASE_API_URL`；
- migration和checkpoint setup已由部署身份执行；
- dispatcher与consumer使用两条不同连接和最小权限角色；
- Web、Worker能访问同一PostgreSQL，Worker能访问Redis；
- API `/api/durable/health/ready`与Worker `/ready`均为200；
- canary完成create → outline reply → terminal SSE → article edit/restore；
- 没有未解释的`run_effects.status = 'uncertain'`。

## 数据库角色

部署身份先执行migration和checkpoint setup，再创建并收敛三个runtime role：

```bash
DATABASE_CHECKPOINT_ADMIN_URL=postgresql://... pnpm setup:checkpoint-schema

DATABASE_ADMIN_URL=postgresql://... \
DURABLE_API_ROLE=vibe_writer_api \
pnpm --filter @vibe-writer/db durable-api-role:provision

DATABASE_ADMIN_URL=postgresql://... \
WRITE_DISPATCHER_DATABASE_ROLE=vibe_writer_write_dispatcher \
pnpm --filter @vibe-writer/db write-dispatcher-role:provision

DATABASE_ADMIN_URL=postgresql://... \
WRITE_CONSUMER_DATABASE_ROLE=vibe_writer_write_consumer \
pnpm --filter @vibe-writer/db write-consumer-role:provision
```

随后必须分别从API、dispatcher和consumer自己的连接执行对应`verify`命令。长期runtime不持有admin URL，也不执行DDL。

## 回滚

1. 停止创建新Job；让已领取任务完成或显式取消。
2. 在Vercel回滚到上一个已验证的TypeScript deployment。
3. Worker回滚到与该Web版本匹配的artifact；保留Redis与PostgreSQL证据。
4. schema/data不兼容时恢复发布前PostgreSQL备份，并重新运行三个runtime role verifier。
5. 复跑health与产品canary后恢复流量。

回滚不再切到Python/SQLite，也不删除新版本产生的数据来“制造一致”。

## 可重复门禁

```bash
pnpm verify
pnpm test:db:postgres:local
pnpm test:worker:production:local
pnpm test:durable-product:local
```
