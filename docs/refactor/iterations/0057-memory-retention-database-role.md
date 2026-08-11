# Iteration 0057：Memory Retention 独立数据库角色

- 日期：2026-08-10
- 状态：Done
- 对应决策：[ADR-0058](../decisions/0058-memory-retention-database-role.md)
- 评测记录：[Eval 0053](../evals/0053-memory-retention-role-canary-baseline.md)

## 目标

把Memory retention从通用owner连接迁到独立、可部署、启动时自校验的数据库角色，并用真实PostgreSQL证明该角色既能跨workspace履行清理义务，又不能读取职责外数据。

## 范围内

- 可复用但不合并manifest的PostgreSQL role contract引擎；
- retention专属table/sequence权限清单与显式`BYPASSRLS`属性；
- provision/verify CLI与content-free JSON报告；
- 独立`DATABASE_MEMORY_RETENTION_URL`和预期role配置，无owner fallback；
- 每个retention实例readiness前的current-connection verifier；
- 一次性真实PostgreSQL、两个workspace和完整expiry路径canary；
- worker env/example、README、retention runbook、系统设计、路线图、ADR与Eval记录同步。

## 范围外

- 不创建、输出或轮换数据库密码；
- 不把retention role用于Worker、dispatcher、Eval、API、migration或人工查询；
- 不选择生产云数据库、连接池或secret manager；
- 不执行真实provider调用或Memory calibration；
- 不改变retention删除语义、批次算法、RLS policy或数据库schema。

## 实现记录

1. 从API专属实现提取`postgres-role-contract.ts`，统一角色名校验、reset-before-grant、有效table/sequence权限全集、属性、membership、ownership和schema verifier；API manifest与行为保持独立。
2. retention manifest仅覆盖source signal/tombstone、extraction ledger、outbox、candidate、active Memory和Memory tombstone；不授sequence或其他业务表权限。
3. `loadMemoryRetentionMaintenanceConfig()`改为强制读取`DATABASE_MEMORY_RETENTION_URL`和`MEMORY_RETENTION_DATABASE_ROLE`，不再接受通用`DATABASE_URL`。
4. production runtime在schema检查与ready之前调用`assertCurrentMemoryRetentionRole()`；错误角色、owner连接、额外grant或缺失grant均阻止启动。
5. 初次真实canary在`INSERT ... ON CONFLICT DO NOTHING`写tombstone时失败，证明仅`INSERT`不足；只为两个tombstone表增加`SELECT`后重跑通过，未扩大其他表权限。
6. canary用owner连接只负责migration、role creation和seed；真实清理通过retention role runtime完成。它同时断言该连接无法`SELECT jobs`。

## 当前验证

- `packages/db` API/retention role unit tests 6/6通过；
- `pnpm typecheck:db`通过；
- Worker retention/architecture tests 15/15通过；
- `pnpm typecheck:worker`通过；
- `pnpm test:memory-retention-role:local`通过：一次性真实PostgreSQL canary 1/1；
- 共享role engine重构后，`pnpm test:memory-api-canary:local`再次通过：真实Next production与API role 1/1；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：contracts 31、model runtime 9、provider runtime 11、eval core 10、eval graders 5、memory core 26、eval CLI 47、agent core 93、workflow runtime 48、DB 129、checkpoint runtime 8、Worker 89、FastAPI 50、Web 65；
- component 38/38、Memory governance 20/20、Memory extraction 24/24与workflow shadow 3/3通过；calibration按预期保持`no_go/configuration_required`且没有provider调用；
- `pnpm check:docs`检查182份Markdown相对链接，`git diff --check`通过。

## 退出条件

1. retention必须使用独立URL与显式role name，且不能回退owner连接：满足；
2. 角色属性、schema、membership、ownership和精确有效权限均由current connection验证：满足；
3. 两个workspace的source、running effect、Memory和candidate expiry由真实runtime清理：满足；
4. content-free tombstone和`uncertain` effect fencing保持正确：满足；
5. retention role不能读取职责外的`jobs`：满足；
6. scoped tests、根级verify、docs与diff检查通过：满足。

## 后续

1. 按实际调用链继续拆分write dispatcher、write consumer/checkpoint、Eval dispatcher/consumer/sampler与migration角色；
2. 在目标环境创建/轮换真实凭据并运行provision、verify和canary等价检查；
3. 配置due backlog、role verification failure和数据库权限漂移告警；
4. operator授权后再执行真实Memory model/cost calibration。
