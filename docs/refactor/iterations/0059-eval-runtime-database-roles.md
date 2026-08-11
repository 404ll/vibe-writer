# Iteration 0059：Eval Runtime 独立数据库角色

- 日期：2026-08-10
- 状态：Done
- 对应决策：[ADR-0060](../decisions/0060-eval-runtime-database-roles.md)

## 目标

把Eval dispatcher、consumer和live sampler从共享owner连接迁到三套独立、可部署、启动时自校验的数据库角色，并把sampler的content-free承诺落实为数据库column-level权限。

## 范围内

- column-aware PostgreSQL role contract、provision与current-connection verifier；
- Eval dispatcher/consumer/live sampler独立manifest和CLI；
- queue `all`模式双连接与sampler专属URL/role，无通用fallback；
- runtime启动前角色和schema校验；
- 真实PostgreSQL/Redis queue projection、真实PostgreSQL sampler canary与权限负例；
- Eval README、系统设计、路线图、runbook、ADR与Eval记录同步。

## 范围外

- 不创建、输出或轮换生产密码；
- 不定义register/enqueue/authorization等人工CLI、CI artifact、migration或ops角色；
- 不改变Eval dataset、target registry、grader、sampling、approval、retention或cost语义；
- 不执行真实provider调用或付费校准；
- 不选择云数据库、secret manager、连接池或网络策略产品。

## 实施计划

1. 扩展共享role engine，精确清除、授予和验证column privilege，同时保持现有API/retention/write契约。
2. 建立三套Eval runtime manifest、provision/verify CLI与单元测试。
3. 调整queue/sampler配置与runtime composition，强制独立URL/role并在业务loop前自校验。
4. 把Eval Redis integration升级为真实PostgreSQL双role projection；把sampler PostgreSQL测试升级为专用column ACL canary。
5. 运行既有角色canary、root verify、docs与diff检查后收口状态。

## 完成内容

- `postgres-role-contract`新增column privilege manifest、残留列授权清除和current-connection精确校验，既有API、retention与write manifest保持原边界；
- 新增Eval dispatcher、consumer、live sampler三套角色契约及provision/verify CLI；
- queue配置改为按启用职责要求`DATABASE_EVAL_DISPATCHER_URL`或`DATABASE_EVAL_CONSUMER_URL`，`all`拒绝相同URL/role；sampler只接受专用URL/role；
- queue runtime创建两个数据库client并在启动BullMQ/dispatch loop前分别校验角色和schema；sampler同样先校验角色再扫描；
- 新增真实PostgreSQL+Redis联合canary，owner只负责migration/provision/seed/assertion，runtime使用两个non-owner连接完成38-case queued Eval；
- sampler PostgreSQL canary改用第三个non-owner角色，并验证安全列可读、正文/topic/DDL被数据库拒绝；
- 新增[部署Runbook](../runbooks/eval-runtime-roles.md)与[Eval 0055](../evals/0055-eval-runtime-role-canary-baseline.md)。

## 当前验证

- `pnpm typecheck:db`通过；四组role contract定向测试14/14通过；
- `pnpm typecheck:eval-cli`通过；queue/config/sampler/architecture定向测试20/20通过；
- `pnpm test:eval-queue:local`通过：既有Redis集成2/2，真实PostgreSQL+Redis双role canary 1/1；
- `pnpm test:db:postgres:local`通过：DB 21/21、checkpoint 4/4、sampler列级ACL canary 1/1；
- sampler安全列读取成功，`articles.content`、`jobs.topic`和DDL被拒绝；dispatcher读取`eval_runs`、consumer读取`outbox_events`及两者DDL被拒绝；
- root `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：DB 137、checkpoint runtime 10、Worker 91、FastAPI 50、Web 65，全部TypeScript、migration、Memory/Eval、workflow shadow、lint与Next production build门禁绿色；
- `pnpm check:docs`检查189份Markdown相对链接，`git diff --check`通过。

## 遗留项

- 目标环境仍需创建/轮换三套secret，配置TLS、网络来源、连接池预算、告警与滚动发布证据；
- migration、人工register/enqueue/authorization CLI、CI artifact与运维查询仍需独立角色设计；
- dispatcher/consumer独立进程拓扑下的吞吐、P95/P99和故障注入尚未验证；
- 本轮没有授权真实provider、付费judge或Memory calibration。

## 退出条件

1. 三个runtime没有owner/general URL fallback，queue `all`模式不能合并身份；
2. role属性、schema、membership、ownership和精确table/column/sequence权限由current connection验证；
3. sampler真实完成跨workspace扫描，但读取`articles.content`被数据库拒绝；
4. dispatcher/consumer在两个non-owner连接上完成pointer publish、claim和atomic report commit；
5. dispatcher不能读Eval run、consumer不能读outbox，三者不能创建schema；
6. 既有API/retention/write角色无回归，scoped tests、根级verify、docs与diff检查通过。
