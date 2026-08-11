# Iteration 0063：Python 退役与 Vercel Preview 边界

- 日期：2026-08-11
- 状态：Done
- 对应决策：[ADR-0064](../decisions/0064-retire-python-and-adopt-vercel-web.md)

## 目标

把仓库从迁移期双栈收敛为唯一TypeScript产品路径，并准备可部署到受保护Vercel Preview的Next.js Web/API；BullMQ Worker继续由独立常驻进程承载。

## 范围内

- 删除FastAPI/Python运行时、pytest入口、Next fallback rewrite与Python workflow shadow runner；
- 删除SQLite article import可执行路径及其production composition场景；
- 收紧Article contract并让浏览器和Server Component默认只使用PostgreSQL durable路径；
- 新增Vercel monorepo配置、Preview单用户身份边界与部署环境变量示例；
- 更新当前架构、路线图、runbook和仓库开发规范。

## 范围外

- 把BullMQ Worker改写成Vercel Function或Vercel Queues；
- 正式多用户Auth、Production公开域名与计费优化；
- 采购或创建托管PostgreSQL、Redis资源；
- 删除历史ADR、iteration和作为迁移证据保留的确定性fixture。

## 验收条件

1. 仓库没有可启动的Python/FastAPI、SQLite fallback或Next API rewrite；
2. `pnpm verify`完全由TypeScript链路通过；
3. production composition仍覆盖Worker、PostgreSQL、Redis、SSE和Article SSR；
4. Vercel配置能从`apps/web`构建monorepo应用；
5. Preview固定身份在非受保护Vercel Preview环境fail closed；
6. 文档明确Vercel Web/API与外部常驻Worker的部署边界。

## 当前验证

- `pnpm verify`：纯TypeScript全仓通过；Contracts `30/30`、DB `134/134`、Worker `91/91`、Web `66/66`，全部typecheck、Eval、lint、Next production build与198个Markdown链接通过。
- `pnpm test:worker:production:local`：一次性真实PostgreSQL/Redis、最小权限dispatcher/consumer与Next SSR composition `5/5`通过；legacy SQLite场景已从harness移除。
- `pnpm test:durable-product:local`：create → outline reply → terminal SSE → Article edit/history/restore通过，revision为`0 → 1 → 2`，provider fixture请求5次。
- `vercel build --yes --scope elemens-projects`：从`apps/web`读取monorepo配置，安装14个workspace package，生成全部Next.js serverless functions与静态资源，Preview build通过。
- 文件审计：工作树不存在`.py`源码；`apps/api`残留SQLite只读核对为0篇article、0条version后与pytest缓存一起删除。历史Git内容仍可恢复，空本地数据库不保留。
- `git diff --check`：通过。

六项验收条件全部满足。Vercel项目`elemens-projects/web`已经关联，但真正可用的Preview仍等待外部PostgreSQL、Redis、Worker和Preview Protection/环境变量配置；未发布一个API不可用的空壳部署。
