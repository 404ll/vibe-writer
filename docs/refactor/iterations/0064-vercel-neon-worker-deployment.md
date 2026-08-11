# Iteration 0064：Vercel、Neon 与外部 Worker 部署

- 状态：In progress
- 日期：2026-08-11
- 关联：[ADR-0064](../decisions/0064-retire-python-and-adopt-vercel-web.md)

## 目标

把Iteration 0063冻结的发布边界真正部署为可验收的个人MVP：Vercel Preview承载Next.js Web/API，Neon Free承载共享PostgreSQL，个人服务器以独立systemd服务承载Redis与TypeScript Worker，同时不影响机器上已有Hermes服务。

## 本轮范围

- 创建并初始化仅供Preview使用的Neon Free PostgreSQL；
- 执行Drizzle migration、LangGraph checkpoint setup和API/dispatcher/consumer最小权限角色provision/verify；
- 创建固定单用户principal、workspace与owner membership；
- Vercel只配置`DATABASE_API_URL`，Durable API不允许回退Marketplace注入的owner `DATABASE_URL`；
- 为Preview启用Vercel Authentication并部署非production分支；
- 在个人服务器以独立目录、loopback Redis、并发1 Worker和独立健康端口部署；
- 复用旧项目已有provider变量，但不读取Hermes环境、不向Vercel发送provider secret。

## 范围外

- Production域名与公开流量；
- 多用户Auth；
- Memory产品恢复与高级Eval；
- 将PostgreSQL自托管到个人服务器；
- 修改或重启Hermes服务。

## 验证证据

- `vercel integration add neon --plan free_v3 ...`：Neon资源创建并连接Preview成功；
- 数据库migration与checkpoint setup：通过；
- API role verifier：`46`项table、`2`项sequence权限通过；
- dispatcher role verifier：`1`项schema、`2`项table权限通过；
- single-workspace consumer verifier：`2`项schema、`29`项table权限通过；
- 固定principal/workspace owner membership：创建并由repository反查通过；
- `pnpm --filter @vibe-writer/db test`：`135`项通过；
- `pnpm --filter @vibe-writer/worker test`：`92`项通过；
- `pnpm --filter @vibe-writer/web test`：`67`项通过；
- 相关package typecheck：通过；
- `pnpm build:web`：Next.js production build通过；
- `pnpm test:worker:production:local`：真实PostgreSQL、Redis、5项Worker production projection与Next readiness/article读取通过；
- Vercel Preview构建与受保护访问：待完成；
- Worker `/ready`与产品主链路：待完成。

## 退出条件

只有数据库角色验证、Vercel Preview、Worker readiness和create → outline reply → terminal SSE → article edit/restore全部通过后才能标记`Done`。
