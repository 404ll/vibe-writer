# Iteration 0060：MVP 完成审计与范围冻结

- 日期：2026-08-10
- 状态：Done
- 对应决策：[ADR-0061](../decisions/0061-mvp-scope-freeze.md)

## 目标

按“完成MVP即可”的产品边界审计当前重构结果，撤回不影响MVP价值验证的额外workspace operator角色实现，固定已完成能力、明确production backlog，并以当前代码和验证证据判断MVP是否可收口。

## MVP 验收矩阵

| 要求 | 权威证据 | 当前判断 |
|---|---|---|
| Next.js Web可运行 | App Router routes、Web tests、production build | 已满足 |
| TypeScript Agent核心行为 | `agent-core`组件测试、Python/TS workflow shadow | 已满足 |
| Durable异步写作主链路 | PostgreSQL、BullMQ、Worker、checkpoint、outbox、terminal projection canary | 已满足 |
| 恢复与失败语义 | outline resume、cancel、provider failure、expired lease takeover projection | 已满足 |
| Next API/SSE兼容 | shared contracts、Route Handler/Web tests、production composition | 已满足 |
| Memory管理基础 | consent、candidate review、active Memory、delete、policy UI与RLS tests | 已满足 |
| Eval与版本化基础 | component/workflow baselines、durable Eval queue、live sampling/governance | 已满足 |
| 可追踪开发过程 | system design、roadmap、ADR、iteration log、Eval records、runbooks | 已满足 |

## 范围处理

- 撤回本轮新增的workspace Eval operator role、CLI迁移、canary和部署文档；该工作属于production hardening，不是MVP关键路径。
- 保留`run-postgres-integration`按Eval namespace统计case/run/outbox/trial/score的修正；它消除不同suite共库时的脆弱全局计数，不增加产品架构。
- Iteration 0059作为最后一个实现迭代；后续默认进入用户验证，不自动继续synthetic publisher、migration、ops角色、RAG或付费calibration。

## 当前验证

- `pnpm test:db && pnpm typecheck:db`：137项DB测试与类型检查通过；
- `pnpm test:eval-cli && pnpm typecheck:eval-cli`：50项Eval CLI测试与类型检查通过；
- `pnpm test:db:postgres:local`：DB 21/21、checkpoint 4/4、live sampler 1/1及namespace-scoped Eval统计断言通过；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：contracts、model/provider runtime、Eval、Memory、Agent、workflow、DB、checkpoint、Worker、FastAPI、Web lint/test/build和191个Markdown链接全部通过；其中component Eval 38/38、workflow shadow 3/3、Memory governance 20/20、Memory extraction 24/24；
- `pnpm check:docs`与`git diff --check`：通过；
- 付费Memory calibration仍返回设计中的`no_go/configuration_required`，证明默认关闭边界，没有被误判为MVP失败。

## Production Backlog（非 MVP）

- 真实Auth/Ingress、direct-to-Next封锁与目标环境切流；
- 云PostgreSQL/Redis、TLS、secret rotation、pool预算、告警和灾备；
- synthetic publisher、migration、运维查询等剩余数据库角色；
- 真实judge/Memory calibration费用与人工质量核对；
- retrieval/pgvector、answer-uplift Eval与容量/故障演练；
- 最终删除FastAPI/Python兼容路径。

## 退出条件

1. 验收矩阵每项都有当前代码和测试证据；
2. 0060过度实现已完整撤回，不留下失效配置、链接或测试；
3. scoped tests、真实PostgreSQL harness、根级verify、docs与diff检查通过；
4. 文档明确区分MVP完成和production readiness，路线图不再暗示自动扩建；
5. 没有新的MVP必需工作遗留。

## 结论

五项退出条件全部满足，MVP完成。项目从“自动推进基础设施重构”切换为“用户验证驱动”：没有真实反馈、上线阻塞或Eval退化时，不再开启新的技术迭代。
