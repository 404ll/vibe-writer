# Iteration 0054：Durable Memory Management Staging API

- 日期：2026-08-09
- 状态：Done
- 对应决策：[ADR-0055](../decisions/0055-durable-memory-management-staging-api.md)
- 评测记录：[Eval 0050](../evals/0050-memory-management-staging-api-baseline.md)

## 目标

把已有active Memory读取、candidate治理、audit和owner erasure能力组成默认关闭的Next.js management staging API，使user-authored signal不再是只有写入、没有查看与治理的单向入口。

## 范围内

- `@vibe-writer/contracts/memory-management`严格wire schema；
- active Memory、candidate、event的最小人工决策DTO；
- active/candidate默认50、最大100的opaque keyset cursor pagination；
- materialize/reject固定reason、explicit conflict replacement与replay响应；
- owner deletion固定reason与content-free receipt；
- `GET /api/durable/memory`与`DELETE /api/durable/memory/:id`；
- candidate list、event、review三组Route Handler；
- repository not-found/review-conflict结构化错误；
- 独立feature flag、trusted identity、membership、scoped repository与RLS复用；
- no-store与内部fingerprint/source/actor边界测试；
- ADR、Eval、系统设计、路线图和cutover runbook同步。

## 范围外

- 不实现产品Memory管理页面、consent policy展示组件或导航入口；
- 不增加revision history全文API、分页、搜索或批量审核；
- 不修改ADR-0038的workspace viewer active-read语义；
- 不启用production Memory consumer、provider或付费调用；
- 不实现embedding、retrieval或Agent context injection；
- 不部署真实auth/proxy或专用API role。

## 当前验证

- `pnpm test:contracts`：29/29；contracts typecheck通过；
- `pnpm test:web`：50/50；Web lint与Next production build通过；
- targeted DB architecture + Memory repository：26/26；完整DB：122/122；DB typecheck与migration check通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL 21/21、checkpoint 4/4、live sampler 1/1；分页遍历与完整workspace集合一致、跨页无重复；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：contracts 29、model runtime 9、provider runtime 11、eval core 10、eval graders 5、memory core 26、eval CLI 47、agent core 93、workflow runtime 48、DB 122、checkpoint runtime 8、Worker 87、FastAPI 50、Web 50；
- Memory governance、extraction与workflow shadow Eval通过；calibration继续按预期返回`no_go/configuration_required`，本轮没有真实provider调用；
- `pnpm check:docs`：173份Markdown相对链接通过；`git diff --check`通过；
- Next build列出active/list/delete、candidate list/event/review五个management路由。

## 退出条件

1. management API独立feature flag默认关闭：满足，配置与路由测试已证明。
2. active DTO提供当前正文/revision但不泄露fingerprint/current candidate：满足，strict contract与HTTP投影测试已证明。
3. candidate DTO足够人工审核但不泄露source UUID/evidence/actor：满足，strict contract与HTTP投影测试已证明。
4. viewer/editor/owner矩阵完全沿用repository与RLS：满足，Web权限矩阵与真实PostgreSQL RLS回归已证明。
5. conflict replay/collision/expiry/not-found具有明确HTTP语义：满足，route/repository回归已证明。
6. owner删除清除完整slot且receipt不含正文/fingerprint：满足，repository、HTTP与真实PostgreSQL回归已证明。
7. 路由不导入provider/queue/retrieval并保持no-store：满足。
8. collection read有界且cursor不能越过workspace predicate/RLS：满足，最大limit、opaque cursor、workspace-leading index与真实PostgreSQL逐页集合核对已证明。

## 后续

1. 建立versioned consent policy registry与真实展示组件；
2. 以这些API实现role-aware Memory管理页面；
3. 用真实auth adapter和非owner API role跑HTTP canary；
4. 完成真实model calibration后再启用shadow consumer；
5. 进入retrieval port、context assembly和answer-uplift Eval。
