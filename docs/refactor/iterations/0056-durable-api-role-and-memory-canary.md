# Iteration 0056：Durable API Role 与 Memory Canary

- 日期：2026-08-10
- 状态：Done
- 对应决策：[ADR-0057](../decisions/0057-durable-api-role-and-memory-canary.md)
- 评测记录：[Eval 0052](../evals/0052-durable-api-role-memory-canary-baseline.md)

## 目标

把“公开API应使用非owner、无`BYPASSRLS`角色”和“trusted proxy必须清洗身份header”从部署建议提升为可执行契约，并用真实PostgreSQL、production Next.js与HTTP证明Memory治理路径能在该边界内工作。

## 范围内

- 整个Durable HTTP面的精确table/sequence权限清单；
- role attribute、membership、ownership、schema与有效权限全集verifier；
- 受控provision/verify CLI，不创建或输出密码；
- 数据库范围`PUBLIC` schema CREATE安全基线；
- 一次性真实PostgreSQL与受控migration；
- 只使用`DATABASE_API_URL`的production build与`next start`；
- 删除客户端`x-vibe-*`、按测试session注入可信scope的loopback proxy；
- 401/403、header覆盖、viewer/editor/owner、跨workspace、signal、review与erasure HTTP矩阵；
- legacy FastAPI rewrite改为fallback，避免抢占动态Durable Route Handler；
- ADR、Eval、系统设计、路线图、runbook与Web说明同步。

## 范围外

- 不选择或接入真实Auth.js/Clerk/OIDC供应商；
- 不声称本地proxy等于托管Ingress或production认证证明；
- 不创建、轮换或打印数据库密码；
- 不为Worker、dispatcher、migration、retention或Eval复用API角色；
- 不启用Memory provider、shadow consumer、embedding或retrieval；
- 不执行付费model calibration。

## 实现记录

1. 初次canary发现API角色仍通过`PUBLIC`获得schema CREATE；provisioning加入数据库级撤销，verifier继续检查有效权限而非直接grant。
2. 初次动态candidate review被array-form `/api/:path*` rewrite转发到FastAPI；rewrite改为`fallback`后真实`[candidateId]` Route Handler优先匹配。
3. signal撤回在`SELECT FOR UPDATE`处报permission denied；清单只为`memory_source_signals`补充事务实际所需的`UPDATE`，未扩大为全表CRUD。
4. canary fixture使用service连接migration/seed，随后所有HTTP请求由专用API连接处理；service连接不参与HTTP成功路径。

## 当前验证

- `pnpm typecheck:db`通过；
- Web TypeScript、lint与普通Web 65/65通过；canary从普通suite显式排除，只能由独立config运行；
- DB 126/126通过，新增role contract 3/3；
- `pnpm test:memory-api-canary:local`通过：真实PostgreSQL、Next production build、`next start`、专用API role verifier与loopback proxy 1/1；
- canary覆盖伪造header无session 401、mismatched scope 403、viewer capability/shared signal/review/delete拒绝、editor candidate materialize、owner erasure、跨workspace空集合和author signal撤回；
- canary响应检查不含source signal id、evidence fingerprint、review actor、slot fingerprint或删除正文；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：contracts 31、model runtime 9、provider runtime 11、eval core 10、eval graders 5、memory core 26、eval CLI 47、agent core 93、workflow runtime 48、DB 126、checkpoint runtime 8、Worker 87、FastAPI 50、Web 65；
- Memory governance、extraction与workflow shadow Eval通过；calibration按预期返回`no_go/configuration_required`，没有真实provider调用；
- `pnpm check:docs`检查179份Markdown相对链接，`git diff --check`通过。

## 退出条件

1. API角色不是owner/superuser/BYPASSRLS，且无membership、对象ownership或schema CREATE：满足，current-connection verifier已证明。
2. 有效table/sequence权限与机器清单完全相等，缺失和额外权限都失败：满足。
3. 真实Next runtime只使用`DATABASE_API_URL`完成Memory读写治理：满足。
4. 代理入口覆盖伪造header，无session和mismatched membership分别返回401/403：满足。
5. viewer/editor/owner与跨workspace矩阵经过真实HTTP和RLS：满足。
6. 动态Durable Route Handler不被legacy rewrite抢占：满足，review与signal delete已真实执行。
7. 普通回归、根级verify、docs与diff检查全部通过：满足。

## 后续

1. 在目标部署的真实Ingress/Auth adapter复跑header伪造与direct-to-Next封锁检查；
2. 为retention、Worker、dispatcher与migration分别建立独立最小权限角色；
3. 由operator选择model/pricing/cost cap后运行真实Memory calibration；
4. calibration通过后才进入shadow consumer、retrieval port与answer-uplift Eval；
5. 将API role verifier纳入每次migration后的部署门禁，新增Route Handler数据访问时同步更新契约。
