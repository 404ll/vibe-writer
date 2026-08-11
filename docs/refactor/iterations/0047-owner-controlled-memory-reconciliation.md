# Iteration 0047：Owner-controlled Memory Reconciliation

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0048](../decisions/0048-owner-controlled-memory-reconciliation.md)
- 评测记录：[Eval 0043](../evals/0043-memory-reconciliation-fault-baseline.md)

## 目标

为Memory extraction `uncertain`状态建立owner-controlled、append-only、预算一致且不会盲目重试的reconciliation状态机。

## 范围内

- confirmed-failed/confirmed-succeeded decision与三类evidence contract；
- reconciliation append-only表、effect唯一resolution、workspace幂等和RLS；
- owner-only repository与workspace-scoped facade；
- task/attempt/effect事务锁与状态转换；
- confirmed failure的hold/有界requeue；
- confirmed success的实际费用结算与result-unavailable终态；
- erased signal禁止requeue；
- PGlite、真实PostgreSQL双session幂等和RLS验证；
- 修复预算算法的BigInt字面量跨包兼容性，保证低于ES2020 target的Next.js consumer也能完成类型检查；
- ADR、Iteration、Eval、系统设计与路线图同步。

## 范围外

- 不实现Anthropic或其他provider lookup adapter；
- 不导入真实账单，不保存provider response/model output；
- 不增加HTTP管理API、双人审批、告警或dashboard；
- 不启用production Memory consumer；
- 不实现真实model calibration、embedding或retrieval。

## 验证

- `pnpm typecheck:db && pnpm test:db && pnpm check:migrations`：17个文件、114项测试通过，类型检查与migration drift检查通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL DB 19项、PostgresSaver 4项、live sampler 1项通过；
- `pnpm test:memory-core && pnpm typecheck:memory-core && pnpm build:web`：Memory 26项测试与类型检查通过，Next.js production build通过；
- 根级`pnpm verify`：contracts、runtime、eval、Memory、DB、Worker、API、Web与文档门禁全部通过；
- `pnpm check:docs`与`git diff --check`：通过。

## 退出条件

1. 非owner不能提交resolution：满足。
2. 同一effect只能产生一条、可幂等重放的审计决策：PGlite与真实PostgreSQL满足。
3. confirmed failure只有显式且有界时才能requeue：满足。
4. confirmed success不能因结果丢失而再次收费：满足。
5. budgeted resolution必须匹配usage/cost/pricing evidence：满足。
6. erased signal不得requeue：满足。
7. workspace RLS、migration和根级gate通过：满足。

## 后续

1. 建立provider lookup port和scripted/真实adapter contract；
2. 增加reconciliation backlog query、age/SLO和告警；
3. 设计HTTP管理API、组织级权限与双人审批；
4. 运行真实Memory extractor quality/cost calibration；
5. staging shadow后再决定production consumer。
