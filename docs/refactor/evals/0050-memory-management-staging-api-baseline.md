# Eval 0050：Memory Management Staging API 工程基线

- 日期：2026-08-09
- 结论：Passed；contract、DTO boundary、Next.js route、bounded pagination与真实PostgreSQL workspace/RLS回归均通过
- 对应迭代：[0054](../iterations/0054-durable-memory-management-staging-api.md)

## 行为矩阵

| 条件 | 预期结果 |
|---|---|
| durable或management feature关闭 | 503，repository不执行 |
| trusted identity缺失 | 401/503，数据方法不执行 |
| workspace viewer读取active Memory | 200，只返回未过期current revision |
| collection无limit或limit大于100 | 默认50或400，不允许无界读取 |
| opaque cursor重放 | 从同一UUID边界稳定继续，不改变workspace scope |
| viewer读取candidate/review | 403 |
| editor列出candidate/event | 200，保留决策字段，隐藏内部identity/fingerprint |
| editor materialize新slot | 200，revision 1 |
| editor materialize conflict但缺replacement | 409 |
| exact review replay | 200并标记`replayed=true` |
| review intent/actor/replacement漂移 | 409 |
| candidate到期 | 删除candidate并返回410 |
| candidate或Memory不可见/不存在 | 404 |
| editor删除active Memory | 403 |
| owner删除active Memory | 200 content-free receipt；完整slot正文清除 |
| owner exact delete replay | 200并标记`replayed=true` |

## 数据边界

- active响应包含当前正文，因为用户必须能查看系统实际使用的Memory；不含content fingerprint/current candidate id；
- candidate响应包含人工审核所需正文、置信度、consent与版本；不含source UUID、evidence/content fingerprint或review actor id；
- event只含seq/type/reason/time；
- delete receipt只含memory id、reason、time与replay，不含slot fingerprint或正文；
- 所有读取`no-store`，PostgreSQL仍是业务真相。
- active/candidate collection使用默认50、最大100的keyset cursor，不使用offset或无界列表。

## 当前证据

- contracts 29/29与typecheck通过；
- Web 50/50，覆盖feature/auth、pagination、active DTO、candidate权限与边界、event、review success/replay/conflict/expiry/not-found、delete权限与receipt；
- Web lint与Next production build通过；
- targeted DB architecture + Memory repository 26/26；完整DB 122/122，typecheck与migration check通过；
- 新migration只增加`memories(workspace_id,id)`和`memory_candidates(workspace_id,id)`两个分页索引；
- 真实PostgreSQL 21/21、checkpoint 4/4、live sampler 1/1；cursor逐页结果有界、无重复、workspace一致且与完整集合相等；
- 根级`pnpm verify`通过，含FastAPI 50/50、Worker 87/87、Web 50/50、Memory/Eval gates与173份Markdown链接检查；
- calibration仍按设计返回`no_go/configuration_required`，没有选择model/pricing，也没有发生真实provider调用。

## 尚未证明

- 真实trusted proxy/header stripping与非owner API role；
- 产品管理UI、policy展示和可用性；
- production consumer、真实模型质量、成本和retrieval uplift。
