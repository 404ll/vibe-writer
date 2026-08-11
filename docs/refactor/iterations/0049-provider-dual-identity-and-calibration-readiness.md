# Iteration 0049：Provider Dual Identity 与 Calibration Readiness

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0050](../decisions/0050-provider-dual-identity-and-memory-calibration-readiness.md)
- 评测记录：[Eval 0045](../evals/0045-memory-calibration-readiness-baseline.md)
- 能力审计：[Anthropic Messages 2026-08-07](../provider-audits/anthropic-messages-2026-08-07.md)

## 目标

纠正provider request/response identity语义，并在任何付费Memory calibration之前建立版本化、offline、fail-closed的readiness gate。

## 范围内

- model/tool response contract增加独立`responseId`；
- Anthropic HTTP `request-id`与Message object `id`分别映射；
- trace、Eval score、Memory effect/reconciliation双identity持久化；
- 独立request/response identity drift防护；
- nullable schema migration与真实PostgreSQL覆盖；
- 24-case、3 trials/case、72 calls的planned calibration manifest；
- offline readiness checker、CLI、架构门禁和官方provider能力审计；
- ADR、Iteration、Eval、系统设计与路线图同步。

## 范围外

- 不选择或调用真实付费model；
- 不绑定易漂移pricing或设置未经确认的cost cap；
- 不保存model output，不创建真实provider lookup adapter；
- 不把aggregate usage或batch result解释为同步request terminal evidence；
- 不启用production Memory extraction、自动reconciliation、HTTP/UI或scheduler。

## 验证

- provider/model/eval runtime定向测试与类型检查通过；provider-runtime 3个文件、11项测试；
- `pnpm test:db && pnpm typecheck:db && pnpm check:migrations`：17个文件、116项测试通过；
- `pnpm test:worker && pnpm typecheck:worker`：12个文件、78项测试通过；
- `pnpm test:eval-cli && pnpm typecheck:eval-cli`：10个文件、37项测试通过；
- `pnpm eval:memory-calibration`：确定返回`no_go`，四项blocker完整；
- `pnpm test:db:postgres:local`：真实PostgreSQL双identity、reconciliation、RLS及既有联合门禁通过；
- 根级`pnpm verify`、`pnpm check:docs`与`git diff --check`通过。

## 退出条件

1. Anthropic request与response identity不再混用：满足。
2. trace、Eval、effect、reconciliation端到端保留双identity：满足。
3. identity drift不产生audit或ledger mutation：满足。
4. calibration plan缺少model/pricing/live trials时稳定No-Go：满足。
5. readiness gate不读取credentials、不联网、不修改业务数据：满足。
6. provider能力限制有官方来源、日期和复审触发器：满足。
7. PGlite、真实PostgreSQL、根级验证和文档门禁通过：满足。

## 后续

1. 由明确配置选择calibration model、model profile、固定pricing snapshot与最大成本；
2. 实现只消费manifest的付费shadow runner，先支持dry-run/cost preview，再在授权后运行；
3. 保存content-free trial计量与quality score，不保存Memory正文或模型原始输出；
4. 用真实trial更新baseline并决定Go/No-Go，不能只凭一次平均分；
5. provider terminal evidence仍不可用时，production unknown outcome继续人工hold。
