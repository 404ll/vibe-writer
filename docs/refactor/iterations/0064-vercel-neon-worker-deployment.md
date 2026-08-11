# Iteration 0064：Vercel、Neon 与外部 Worker 部署

- 状态：Done
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
- Vercel Preview `https://web-cjlufw3ix-elemens-projects.vercel.app`：构建完成，Vercel Authentication保护下的`/api/durable/health/ready`返回`ready`；
- 服务器`vibe-writer-worker.service`：systemd启用且运行中，`/ready`返回`ready`；Redis只监听loopback，Worker环境文件权限为`600`；
- 真实任务`520ae891-bd5e-4ccf-a842-c0403a520f6a`：完成create → outline reply → export，生成Article `a35ae592-7f4d-4222-a2b6-22bc25ab5d93`；
- Article API与页面：文章revision `0`时可读取，页面包含任务主题与正文；
- Article编辑与恢复：临时标记写入后revision由`0`变为`1`，版本`1`保存source revision `0`；恢复后revision变为`2`，原文恢复且临时标记消失；
- Hermes：部署与验收过程中没有执行修改或重启命令，最终既有Hermes相关进程保持运行。

## 已知情况

- 首次Git集成部署被Vercel识别为Production，但Production没有应用所需的Preview环境变量，因此应用处于禁用状态；本轮验收只使用上述Preview部署。
- 服务器首次安装完整workspace依赖时触发过一次内存压力，Hermes进程被内核终止后由其自身机制恢复。后续改为过滤安装、限制Worker内存并使用系统Node；最终检查未发现新的OOM，既有Hermes相关进程均正常。

## 退出条件

只有数据库角色验证、Vercel Preview、Worker readiness和create → outline reply → terminal SSE → article edit/restore全部通过后才能标记`Done`。

以上退出条件已经满足。
