# Iteration 0045：Typed Memory Extraction Delivery

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0046](../decisions/0046-typed-memory-extraction-delivery-and-erasure-fencing.md)
- 评测记录：[Eval 0041](../evals/0041-typed-memory-delivery-fault-baseline.md)

## 目标

把Memory extraction ledger、transactional outbox和BullMQ从run-only迁到严格`run | signal` identity，并为signal删除与in-flight provider effect建立可审计的fencing规则。

## 范围内

- task/attempt/effect `source_id/source_kind` schema、migration和RLS兼容；
- signal `ON DELETE RESTRICT`、detached terminal ledger与`source_deleted_at`；
- queued、pre-provider、reserved-provider和completed四类erasure settlement；
- terminal run与explicit signal的v2 pointer-only outbox；
- BullMQ typed job id、strict v2 parser与精确legacy v1 run兼容；
- signal `user/durable` prompt source与trusted subject覆盖；
- PGlite、真实PostgreSQL和真实Redis故障/传递验证；
- 系统设计、ADR、路线图、Iteration与Eval记录同步。

## 范围外

- 不增加HTTP consent API或Memory管理UI；
- 不启用production Memory consumer；
- 不增加自动expiry scheduler或uncertain reconciliation操作面；
- 不调用真实模型，不调整hard cost budget或接受质量baseline；
- 不增加embedding、retrieval cache或Agent context assembly。

## 验证

- `pnpm check:migrations && pnpm typecheck:db && pnpm test:db`：migration无drift，DB 16个文件、107项通过；
- `pnpm typecheck:worker && pnpm test:worker`：Worker 11个文件、62项通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL DB 17项、PostgresSaver 4项、live sampler 1项通过；
- `pnpm test:worker:redis:local`：真实Redis/BullMQ 9项通过，run和signal消息均为pointer-only；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：通过；component Eval 38/38、Memory governance Eval 20/20、Memory extraction Eval 24/24、workflow shadow Eval 3/3；Web lint/test/build、Python API测试、全仓类型检查与migration check全部通过；
- `pnpm check:docs && git diff --check`：144份Markdown链接与diff whitespace检查通过。

## 退出条件

1. run/signal必须共享typed ledger且旧run账本可无损回填：满足。
2. signal正文不得进入outbox或Redis：满足。
3. 删除发生在provider reservation前必须取消并阻止迟到Worker：满足。
4. 删除发生在可能收费后必须保留审计并fail closed为uncertain：满足。
5. completed ledger必须在删除source后保留content-free历史：满足。
6. migration、真实PostgreSQL锁/外键、真实Redis delivery和根级gate全部通过：满足。

## 后续

1. 建立provider/model维度hard cost budget和真实model calibration；
2. 增加`uncertain` reconciliation策略和受控运维入口；
3. 在staging接入consent API、source-scoped enqueue和expiry scheduler；
4. 通过shadow consumer后再评估production启用；
5. 随retrieval/embedding落地扩展同一source erasure contract。
