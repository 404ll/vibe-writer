# Vercel Preview + 外部 TypeScript Worker Runbook

## 目标

用Vercel承载Next.js页面、Route Handler与SSE，用独立服务器承载BullMQ Worker。该拓扑用于个人MVP Preview，不等于公开Production设计。

## 1. 外部资源

需要一套Web与Worker都能访问的PostgreSQL，以及只需Worker访问的Redis：

- PostgreSQL建议使用支持serverless pooling的TLS连接端点；
- Redis必须支持BullMQ所需命令和长连接；托管实例使用`rediss://`，与Worker同机时优先绑定`127.0.0.1`并使用`redis://127.0.0.1:6379`；
- migration/admin、API、dispatcher、consumer使用不同数据库身份；
- provider key只放Worker，不放Vercel Web。

## 2. 数据库准备

从受控部署环境运行Drizzle migration、checkpoint setup，以及API/dispatcher/consumer role provision与self-verify。命令见[Durable发布runbook](./durable-cutover.md)。

先为Preview单用户创建principal、workspace和membership。`DURABLE_SINGLE_USER_PRINCIPAL_ID`与`DURABLE_SINGLE_USER_WORKSPACE_ID`必须对应这组已存在记录，不能随意填UUID。

## 3. Vercel Project

1. 导入GitHub仓库；Root Directory选择`apps/web`。
2. 保持Include source files outside Root Directory开启，使pnpm workspace package可参与构建。
3. Framework Preset使用Next.js；仓库中的`apps/web/vercel.json`负责从monorepo根目录安装与构建。
4. 在Settings → Deployment Protection中为Preview开启Vercel Authentication。
5. Marketplace可以用于创建数据库，但完成migration与runtime role后要断开项目级资源连接，移除自动注入的owner变量；只向Preview环境写入[`apps/web/.env.example`](../../../apps/web/.env.example)列出的runtime变量。

关键变量：

```text
NEXT_PUBLIC_API_BASE=/api/durable
DURABLE_API_ENABLED=true
DATABASE_API_URL=postgresql://vibe_writer_api:...@.../vibe_writer?sslmode=require
DURABLE_AUTH_MODE=protected-single-user
DURABLE_EXTERNAL_ACCESS_PROTECTION=true
DURABLE_SINGLE_USER_PRINCIPAL_ID=<existing UUID>
DURABLE_SINGLE_USER_WORKSPACE_ID=<existing UUID>
```

Memory flags保持`false`。不要把admin、dispatcher、consumer、Redis或provider secret放入Vercel。
Durable API只接受`DATABASE_API_URL`，不会回退`DATABASE_URL`；这样即使operator误连Marketplace owner变量也会fail closed。

## 4. Worker服务器

在长期运行的Node.js 22环境安装依赖并启动：

```bash
pnpm install --frozen-lockfile
pnpm start:worker
```

环境变量使用根目录[`.env.example`](../../../.env.example)。`DURABLE_WORKER_ROLE=all`适合单机MVP，但内部仍使用两条独立数据库连接。Neon等不允许operator创建`BYPASSRLS`角色的托管PostgreSQL使用`WRITE_CONSUMER_ACCESS_MODE=single-workspace`，并在consumer URL的`options`参数和`WORKER_SINGLE_USER_WORKSPACE_ID`中配置同一个UUID；readiness会校验两者一致。资源较小的个人服务器固定`WORKER_CONCURRENCY=1`；健康服务绑定`127.0.0.1`，端口要避开现有服务，示例使用`8790`。

部署目录、systemd unit和Redis配置必须与机器上的其他应用隔离。部署前只读检查现有端口、服务名和可用内存；不要重启、覆盖或复用其他应用的进程。

## 5. 验证

1. Worker `/ready`返回200；
2. Vercel `/api/durable/health/ready`返回200；
3. 未登录的无痕窗口被Vercel Authentication拦截；
4. 登录后创建任务，完成outline确认、SSE终态、文章打开、编辑和restore；
5. PostgreSQL中Job、Run、Event、Article、Outbox终态一致；
6. Worker停止时Web仍可读取文章，但新Job保持queued；Worker恢复后队列继续处理。

## 6. 明确边界

- Vercel Function有执行时长上限，SSE客户端必须允许断开后按`after_seq`重连；
- `protected-single-user`依赖平台访问保护，不是多用户Auth；
- Production公开域名上线前必须替换为真实session/identity adapter；
- Vercel回滚只回滚Web artifact，Worker版本和数据库兼容性必须由发布记录共同约束。
