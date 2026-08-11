# Iteration 0043：Explicit User-authored Memory Source Signals

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0044](../decisions/0044-explicit-user-memory-source-signals.md)
- 评测记录：[Eval 0039](../evals/0039-memory-source-signal-baseline.md)

## 目标

建立独立于task topic和assistant article的durable user source数据边界，使显式Memory授权具备幂等、权限、retention、删除和真实RLS证据。

## 范围内

- `memory_source_signals`与content-free tombstone schema/migration；
- `explicit_remember/preference_setting/correction` source kind；
- personal/shared subject授权规则；
- 可选author-owned source run验证；
- request/evidence fingerprint与幂等collision；
- database-time 1–365天retention和批量expiry；
- 作者/owner硬删除与可重放deletion receipt；
- workspace-scoped repository组合入口；
- PGlite repository回归、migration check、真实PostgreSQL RLS扩展。

## 范围外

- 不增加HTTP API或管理UI；
- 不将普通topic、reply或article自动标为durable；
- 不修改run-keyed extraction task/attempt/effect identity；
- 不把signal接入candidate proposal或derived deletion propagation；
- 不发Memory extraction outbox，不启用production consumer；
- 不调用真实模型，不修改extractor quality baseline或cost budget。

## 验证

- `pnpm test:db`：16个文件、103项通过；
- `pnpm typecheck:db`、`pnpm check:migrations`：通过；
- `pnpm test:db:postgres:local`：真实PostgreSQL DB 15项、PostgresSaver 4项、live sampler 1项通过；Memory RLS case新增active signal、deleted signal tombstone、cross-workspace与no-scope断言；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：通过；TypeScript 448项、Python 50项，共498项测试；component Eval 38/38、Memory governance Eval 18/18、Memory extraction Eval 24/24、workflow shadow Eval 3/3；Web lint/test/build、全仓类型检查、migration check与138份Markdown链接检查全部通过；
- `git diff --check`：通过。

## 退出条件

1. durable source必须来自显式用户动作并固定`explicit_user` consent：满足。
2. viewer不能设置shared subject，任何人不能冒充其他principal：满足。
3. source run引用必须属于作者与workspace：满足。
4. retry必须幂等，key复用漂移必须collision：满足。
5. source text必须按retention或用户删除硬清除：满足。
6. deletion receipt不保存正文或可恢复的source metadata：满足。
7. 两张表必须通过真实PostgreSQL RLS隔离：满足。
8. production extraction保持关闭且未伪装为已接入：满足。

## 后续

1. 设计run/signal统一的typed Memory extraction source identity；
2. 将task/attempt/effect、candidate evidence和outbox迁到该source union；
3. 确保signal删除级联candidate/revision/embedding/cache并保留content-free receipt；
4. 增加staging HTTP consent API和管理UI；
5. 再接hard cost budget、真实model calibration与shadow consumer。
