# Iteration 0055：Versioned Memory Policy 与 Management UI

- 日期：2026-08-09
- 状态：Done
- 对应决策：[ADR-0056](../decisions/0056-versioned-memory-policy-and-management-ui.md)
- 评测记录：[Eval 0051](../evals/0051-memory-policy-management-ui-baseline.md)

## 目标

把默认关闭的Memory API组成可操作、可解释且随数据量增长仍有界的管理入口：用户看到的policy必须能由服务端version精确解析，角色能力必须显式投影，首屏不产生客户端权限探测或串行请求瀑布。

## 范围内

- strict `memory-policy`共享契约与append-only server registry；
- 未注册policy version的readiness、signal API与管理页fail-closed；
- policy/access只读API与viewer/editor/owner capability projection；
- own signal默认50、最大100的UUID keyset pagination；
- `(workspace_id, created_by_principal_id, id)`分页索引和migration；
- `/memory`动态Server Component与并行首屏loader；
- policy展示、显式consent signal表单、active/own signal/candidate列表；
- candidate audit、materialize/reject、owner erasure与来源撤回；
- explicit conflict replacement、删除确认、strict响应解析与分页去重；
- 写作页feature-aware导航；
- ADR、Eval、系统设计、路线图、runbook与Web说明同步。

## 范围外

- 不实现policy CMS或允许在线修改历史版本；
- 不实现批量审核、搜索、筛选或revision history全文；
- 不实现真实auth provider、trusted proxy部署或专用API DB role；
- 不启用production Memory consumer、真实模型或付费calibration；
- 不实现embedding、retrieval、context injection或answer uplift；
- 不做写作工作台视觉重设计。

## 当前验证

- contracts 31/31与typecheck通过；
- targeted Web policy/access/loader/route/UI测试通过；完整Web 65/65、lint、typecheck与Next production build通过；
- targeted DB architecture + signal repository 27/27、DB typecheck与migration check通过；
- Next build列出动态`/memory`与`/api/durable/memory/policy`，根页也保持动态feature-aware导航；
- `pnpm test:db:postgres:local`：真实PostgreSQL 21/21、checkpoint 4/4、live sampler 1/1；own signal逐页结果与完整author集合一致；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：contracts 31、model runtime 9、provider runtime 11、eval core 10、eval graders 5、memory core 26、eval CLI 47、agent core 93、workflow runtime 48、DB 123、checkpoint runtime 8、Worker 87、FastAPI 50、Web 65；
- Memory governance、extraction与workflow shadow Eval通过；calibration按预期返回`no_go/configuration_required`，本轮没有真实provider调用；
- `pnpm check:docs`检查176份Markdown相对链接；`git diff --check`通过。

## 退出条件

1. 任意配置version必须精确命中immutable registry，否则写入、展示和readiness均fail closed：满足，configuration/readiness/route测试已证明。
2. policy API只返回注册文本、role/capabilities与允许subject，不泄露内部membership/provenance：满足，strict contract与route测试已证明。
3. UI capability不能替代Route Handler、repository或RLS授权：满足，mutation路径未绕过既有API。
4. own signal读取有界、有索引、cursor不越过workspace/author：满足，migration、PGlite与真实PostgreSQL逐页集合核对已证明。
5. 首屏独立查询并行，viewer/disabled feature不执行受保护collection query：已实现，loader测试已证明。
6. viewer/editor/owner看到的操作与ADR-0038矩阵一致：已实现，UI与access测试已证明。
7. consent、conflict replacement、删除确认和response schema均为显式契约：满足，UI与route测试已证明取消确认时零请求、确认后才删除。
8. 页面/API默认关闭，不引入provider/queue/retrieval：满足。

## 后续

1. 用真实auth adapter和非owner API role执行浏览器canary与header stripping测试；
2. 为policy registry建立历史version不可变CI检查；
3. 完成真实model/pricing/cost授权与calibration后再启用shadow consumer；
4. 进入retrieval port、context assembly与answer-uplift Eval；
5. 有实际候选规模后再以测量证据决定批量审核与搜索设计。
