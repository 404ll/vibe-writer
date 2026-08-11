# Iteration 0058：Write Runtime 独立数据库角色

- 日期：2026-08-10
- 状态：Done
- 对应决策：[ADR-0059](../decisions/0059-write-runtime-database-roles.md)

## 目标

把write dispatcher和write consumer/checkpoint从共享owner连接迁到两个独立、可部署、启动时自校验的数据库角色，并把checkpoint DDL从长期运行consumer移到显式管理步骤。

## 范围内

- schema-aware PostgreSQL role contract与精确权限验证；
- dispatcher/consumer各自的table、schema和sequence manifest；
- 独立数据库URL与预期role配置，`all`模式仍保持身份分离；
- checkpoint schema显式setup命令与部署顺序；
- runtime readiness前的current-connection verifier和schema检查；
- 一次性真实PostgreSQL/Redis production projection canary；
- Worker/env/runbook、系统设计、路线图、ADR与Eval记录同步。

## 范围外

- 不创建、输出或轮换生产密码；
- 不拆分Eval dispatcher/consumer/sampler角色；
- 不改变Job、outbox、lease、terminal、checkpoint或workflow业务语义；
- 不执行真实provider调用或公开流量切换；
- 不选择云数据库、连接池、secret manager或网络策略产品。

## 实现记录

1. role contract引擎升级为schema-aware：未限定对象仍解析到`public`，consumer可显式管理`langgraph_checkpoint`；provision对每个受管schema reset-before-grant，verifier从当前连接枚举有效schema/table/sequence权限并检查属性、membership和ownership。API/retention保持独立manifest。
2. dispatcher manifest只授`outbox_events SELECT/UPDATE`且`NOBYPASSRLS`；consumer manifest按实际调用链授予Job lease/run/effect/trace/terminal/checkpoint attempt、outline command、Article insert、outbox insert和checkpoint DML，并显式`BYPASSRLS`。
3. Worker配置删除通用`DATABASE_URL`入口，按进程role强制读取两套URL/role；`all`模式拒绝相同URL或role，production composition建立两个独立Drizzle连接，PostgresSaver只使用consumer URL。
4. runtime lifecycle移除`setupCheckpoint`。新增`DATABASE_CHECKPOINT_ADMIN_URL`驱动的`pnpm setup:checkpoint-schema`；consumer readiness只做current-role和四张checkpoint表检查。
5. 新增dispatcher/consumer provision/verify CLI、content-free JSON结果、env/example、Worker/checkpoint README和cutover runbook。
6. production harness由owner执行migration/setup/role creation/provision/seed，五类真实projection只通过两个non-owner runtime连接；同轮增加职责外读取、schema DDL和consumer setup负例。

## 当前验证

- DB tests 133/133、Worker tests 91/91、checkpoint runtime tests 10/10通过；相关TypeScript检查通过；
- `pnpm test:worker:production:local`通过5/5：双非owner role、completed、outline resume、running cancellation、provider failure、expired-lease takeover和权限负例全部通过；同一harness内Next production build通过；
- 共享role engine变更后，`pnpm test:memory-api-canary:local`与`pnpm test:memory-retention-role:local`再次通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：contracts 31、model runtime 9、provider runtime 11、eval core 10、eval graders 5、memory core 26、eval CLI 47、agent core 93、workflow runtime 48、DB 133、checkpoint runtime 10、Worker 91、FastAPI 50、Web 65；
- component 38/38、Memory governance 20/20、Memory extraction 24/24与workflow shadow 3/3通过；calibration按预期保持`no_go/configuration_required`且没有provider调用；
- `pnpm check:docs`检查185份Markdown相对链接，`git diff --check`通过。

## 退出条件

1. dispatcher与consumer没有owner/general URL fallback，`all`模式不能合并身份：满足；
2. 两个runtime role的属性、schema、membership、ownership和精确有效权限均由current connection验证：满足；
3. consumer启动路径不执行checkpoint DDL，显式setup步骤可重复执行：满足；
4. 真实production projection在两个非owner连接上覆盖completed、resume、cancel、provider failure与lease takeover：满足；
5. dispatcher不能读Job，consumer不能读outbox，二者不能创建schema：满足；consumer setup也被拒绝；
6. scoped tests、根级verify、docs与diff检查通过：满足。

## 后续

1. 按实际调用链拆分Eval dispatcher/consumer/sampler与migration角色，不复制write manifest；
2. 在目标环境创建/轮换真实凭据，配置网络来源限制与连接池预算，并按runbook执行setup → provision → verify → rollout；
3. 为role verification failure、权限漂移、outbox backlog、checkpoint错误与数据库pool饱和建立外部告警；
4. 完成真实auth/Ingress和历史source dry-run后，再评估受限staging shadow流量。
