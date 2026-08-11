# Iteration 0061：本地 Durable 产品切流

- 日期：2026-08-11
- 状态：Done
- 对应决策：[ADR-0062](../decisions/0062-local-durable-product-cutover.md)

## 目标

把已经通过独立canary的Next durable API与TypeScript Worker组合成开发者可直接使用的本地MVP：一条命令启动后，浏览器默认走`/api/durable`，可创建、确认、取消、恢复、生成和编辑PostgreSQL文章。

## 范围内

- 持久化本地PostgreSQL/Redis compose；
- migration、checkpoint、runtime roles和本地workspace自动初始化；
- development-only固定本地身份；
- Next与Worker一键启动和可诊断退出；
- durable article revision客户端兼容；
- 真实本地HTTP/SSE产品链路验证。

## 范围外

- 公开production Auth/Ingress与公网切流；
- 云数据库、secret manager、灾备和容量演练；
- Memory真实模型consumer、RAG与付费Eval；
- 自动导入用户现有SQLite文章；
- 删除FastAPI/Python回滚路径。

## 验收条件

1. `pnpm dev:durable`能从干净本地infra完成setup并启动Next和Worker；
2. durable health与Worker readiness通过；
3. HTTP创建Job后，Worker消费outbox并产生SSE事件；
4. outline确认或无干预路径可到达terminal article；
5.文章详情、编辑、历史和restore使用PostgreSQL revision协议；
6. Web/DB/Worker定向测试、production integration、docs和diff检查通过。

## 当前验证

### 产品链路

- `pnpm test:durable-product:local`：通过。一次真实本地HTTP composition使用协议兼容的无付费provider fixture，完成Job创建、Outbox/BullMQ消费、`outline_ready`、人工reply、`done`、PostgreSQL Article SSR、revision `0 → 1`编辑、history和`1 → 2` restore；provider请求5次，终态事件为`outline_ready`与`done`。
- 使用现有本地模型配置运行`DURABLE_DEV_ENV_FILE=/absolute/path/to/.env pnpm dev:durable`：PostgreSQL/Redis setup、三个runtime role self-verification、Worker `/ready`、Next durable `/ready`和Article list均返回成功。为避免未经授权产生模型费用，本轮没有自动提交真实provider写作任务；provider wire protocol和production composition由下列集成测试覆盖。
- `pnpm test:worker:production:local`：通过。真实PostgreSQL+Redis、production Worker composition与本地协议provider覆盖completed、outline resume、running cancellation、provider failure和lease takeover共5个场景，并完成Next production build。

### 回归与文档

- `pnpm verify`：通过。包括contracts/model/provider/eval/memory/agent/workflow/checkpoint的测试与typecheck、DB `137/137`、Worker `91/91`、FastAPI兼容基线 `50/50`、Python/TypeScript workflow shadow `3/3`、Web `66/66`、Web lint/build以及文档链接检查。
- `pnpm check:docs`：193个Markdown文件的相对链接均有效。
- `git diff --check`：通过。

### 验收结论

六项验收条件全部满足。本地用户现在可以用一条命令把产品切到TypeScript durable路径并保留PostgreSQL数据；公开production Auth/Ingress、旧SQLite自动导入、Memory provider consumer与付费Eval继续按范围外处理。
