# Iteration 0048：Provider-neutral Memory Request Lookup

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0049](../decisions/0049-provider-neutral-memory-request-lookup.md)
- 评测记录：[Eval 0044](../evals/0044-memory-provider-lookup-fault-baseline.md)

## 目标

为Memory extraction reconciliation建立provider-neutral、content-free、owner-controlled的查询入口，在有明确terminal evidence时自动归一化usage/cost，同时保证pending、not-found和查询故障绝不触发状态修改或盲目重试。

## 范围内

- strict provider request lookup input/result schema；
- `succeeded | failed | pending | not_found`状态语义；
- deterministic evidence fingerprint和scripted lookup adapter；
- owner-only content-free lookup target与completed-operation replay；
- 网络查询与数据库reconciliation事务分离；
- reservation pricing snapshot上的usage cost计算；
- reservation policy与task execution snapshot完整一致性检查；
- confirmed failure默认hold、显式有界requeue；
- PGlite application-service/ledger集成和真实PostgreSQL target/RLS验证；
- ADR、Iteration、Eval、系统设计和路线图同步。

## 范围外

- 不假设或实现Anthropic/其他付费provider的request read API；
- 不执行真实付费模型调用或账单导入；
- 不保存provider response、prompt或Memory候选正文；
- 不增加HTTP/UI、后台scanner、告警、双人审批或production consumer；
- 不完成真实模型quality/cost calibration、embedding或retrieval。

## 验证

- `pnpm test:provider-runtime && pnpm typecheck:provider-runtime`：3个文件、11项测试与类型检查通过；
- `pnpm test:db && pnpm typecheck:db && pnpm check:migrations`：17个文件、114项测试通过；
- `pnpm test:worker && pnpm typecheck:worker`：12个文件、78项测试与类型检查通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL、PostgresSaver和live sampler门禁通过；
- 根级`pnpm verify`：contracts、runtime、eval、Memory、DB、Worker、API、Web与文档门禁全部通过；
- `pnpm check:docs`：153个Markdown文件链接通过；`git diff --check`通过。

## 退出条件

1. lookup contract严格且不携带正文：满足。
2. pending/not-found/transport error不修改ledger：满足。
3. terminal identity drift被拒绝：满足。
4. cost只从reservation pricing snapshot计算，且同版本费率漂移在reservation时被拒绝：满足。
5. requeue仍需owner显式给出边界，erased source不得requeue：满足。
6. exact operation replay不再次查询provider：满足。
7. 真实PostgreSQL target、RLS和根级gate通过：满足。

## 后续

1. 审计目标provider是否提供具有足够语义的request lookup或billing evidence API；
2. 为支持的provider实现真实adapter、错误分类和凭据隔离；
3. 建立retention-bound calibration dataset与付费shadow runner；
4. 对should-write质量、usage、实际账单和reservation误差做baseline；
5. 增加backlog query、age SLO、管理API与双人审批后再考虑production启用。
