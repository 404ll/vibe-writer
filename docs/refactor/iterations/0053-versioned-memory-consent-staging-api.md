# Iteration 0053：Versioned Memory Consent Staging API

- 日期：2026-08-09
- 状态：Done
- 对应决策：[ADR-0054](../decisions/0054-versioned-memory-consent-staging-api.md)
- 评测记录：[Eval 0049](../evals/0049-memory-consent-staging-api-baseline.md)

## 目标

把durable user-authored Memory source signal通过共享契约接入默认关闭的Next.js staging API，并保证consent version、幂等、workspace权限、retention与删除传播不被HTTP层弱化。

## 范围内

- `@vibe-writer/contracts/memory-signals` create/list/delete严格schema；
- 服务端authoritative consent policy version与客户端精确binding；
- 必填`Idempotency-Key`、首次201、exact replay 200、collision 409；
- `GET/POST /api/durable/memory/signals`与`DELETE /api/durable/memory/signals/:id`；
- trusted-proxy身份、membership、scoped repository与RLS复用；
- viewer personal、editor shared、author/owner delete权限保持；
- 不暴露fingerprint、idempotency key、workspace或outbox内部字段的DTO；
- feature/config readiness、no-store、错误投影与Next build路由证据；
- ADR、Eval、系统设计、路线图与切流runbook同步。

## 范围外

- 不增加Memory管理UI或修改signal endpoint；
- 不公开candidate/active Memory/extraction ledger；
- 不启用production Memory dispatcher/consumer或真实provider；
- 不实现真实auth provider、proxy header stripping部署或专用API DB role；
- 不定义consent policy正文、法务审批或产品展示组件；
- 不做embedding、retrieval或Agent context injection。

## 验证

- `pnpm test:contracts`：27/27；`pnpm typecheck:contracts`通过；
- `pnpm test:web`：41/41；`pnpm build:web`通过并生成两个Memory signal Route Handler；
- targeted Memory source repository：7/7；全DB 120/120；`pnpm typecheck:db`通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL DB 21/21、checkpoint 4/4、live sampler 1/1，Eval register/enqueue exact replay通过；
- 根级`API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`通过：contracts 27、model runtime 9、provider runtime 11、eval core 10、eval graders 5、memory core 26、Eval CLI 47、agent core 93、workflow runtime 48、DB 120、checkpoint runtime 8、Worker 87、Python API 50、Web 41；所有typecheck、migration check、Eval gate、Web lint/build通过，Memory calibration按预期保持`no_go`；
- `pnpm check:docs`检查170个Markdown文件通过，`git diff --check`通过。

## 退出条件

1. feature与policy任一未配置时API和readiness fail closed：满足。
2. 客户端不能自行选择最终保存的consent policy version：满足。
3. create必须可重放且payload drift返回409：满足。
4. viewer/editor/owner权限不弱于repository与RLS：满足。
5. list只返回本人active signal且响应不含内部fingerprint：满足。
6. delete执行硬删除/派生清理并返回content-free receipt：满足。
7. API启用不等于production model consumer启用：代码与文档边界已明确。

## 后续

1. 用真实auth adapter和非owner API role跑HTTP canary；
2. 建立policy正文、版本发布和UI确认组件；
3. 增加用户可见的candidate/active Memory管理界面；
4. 完成真实model calibration后，以独立flag启用shadow extraction consumer；
5. 建立retrieval port、context assembly和answer-uplift Eval。
