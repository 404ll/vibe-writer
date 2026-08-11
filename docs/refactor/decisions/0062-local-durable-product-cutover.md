# ADR-0062：本地 Durable 产品切流

- 状态：Accepted
- 日期：2026-08-11

## 背景

Iteration 0060以“受控staging可运行且可回归”收口MVP，但用户验证要求进一步明确为：浏览器切到TypeScript durable API后，应能直接创建任务、执行真实Worker、确认大纲、接收SSE、打开并编辑PostgreSQL文章。现有production canary分别证明了Worker与Web投影，却没有提供一个面向开发者、可持续保存数据的一键组合；默认产品仍走FastAPI。

公开生产切流仍缺真实Auth/Ingress和目标环境证据，本轮不应为了本地产品验证扩建这些能力。

## 决定

1. 新增本地专用`DURABLE_AUTH_MODE=local-development`：
   - 只允许`NODE_ENV=development`；
   - principal/workspace必须来自显式UUID环境变量；
   - 不读取客户端身份header，也不能在production runtime启用。
2. 使用Docker Compose提供持久化的本地PostgreSQL和Redis；使用固定的、仅绑定loopback的开发端口和非生产凭据。
3. 一次性setup由admin连接执行Drizzle migration、checkpoint setup、API/dispatcher/consumer角色创建、精确权限provision和self-verification。长期运行Next与Worker只获得各自runtime连接。
4. `pnpm dev:durable`加载显式env file，完成infra/setup后并行启动Next dev server与真实Node Worker；浏览器API固定为`/api/durable`，文章Server Component也读取PostgreSQL。
5. 修复文章编辑/恢复客户端，使其携带`expected_revision`并消费服务端返回的新revision；旧Python响应仍兼容。
6. 本轮只切写作、SSE和文章读写主链路。Memory模型提取、公开Auth、历史SQLite自动导入和production部署仍不属于本地启动命令。

## 取舍

- 本地使用持久化容器而非每次临时数据库，便于真实产品验证；代价是开发机需要Docker。
- 保留精确数据库角色而不是用owner连接简化启动，避免本地组合掩盖真实runtime权限问题；代价是setup步骤更长，但由脚本自动完成。
- local auth只解决单用户开发，不冒充production身份系统。公开部署仍必须使用trusted proxy或未来session adapter。

## 回滚

停止`pnpm dev:durable`即可停止应用进程；`pnpm dev:durable:down`停止本地infra但保留PostgreSQL volume。浏览器回到默认`pnpm dev:web`时仍使用`/api → FastAPI`。不得把local-development auth带入production。
