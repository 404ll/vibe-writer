# TypeScript 全栈重构文档中心

> 状态：MVP Complete；Production hardening deferred。启动日期：2026-08-07，MVP收口：2026-08-10。

本目录是 vibe-writer 重构的权威入口。Web、API、Agent与Worker已经统一为TypeScript；FastAPI/Python、Next fallback rewrite与SQLite兼容导入根据[ADR-0064](./decisions/0064-retire-python-and-adopt-vercel-web.md)退役。当前部署边界是Vercel Next.js Web/API + 外部常驻TypeScript Worker + PostgreSQL/BullMQ；Neon Preview的固定workspace consumer适配见[ADR-0065](./decisions/0065-managed-postgres-single-workspace-consumer.md)。Memory根据[ADR-0063](./decisions/0063-memory-deferred-from-product-mvp.md)延后，不属于当前产品。

## 文档地图

| 文档 | 责任 | 更新时机 |
|---|---|---|
| [系统设计](./system-design.md) | 长期目标、模块边界、数据流和系统不变量 | 架构边界变化时 |
| [技术路线图](./roadmap.md) | 阶段、依赖、退出条件和当前状态 | 每个迭代开始或结束时 |
| [ADR](./decisions/) | 记录一个重要决策及其取舍 | 做出或推翻架构决策时 |
| [迭代日志](./iteration-log.md) | 所有实施迭代的索引和验证状态 | 每次代码迭代时 |
| [迭代记录](./iterations/) | 单次迭代的范围、变更、验证和遗留项 | 与对应代码一起更新 |
| [评测记录](./evals/) | dataset、版本、兼容差异和可重复评测证据 | 每次组件或端到端 eval 后 |
| [Provider能力审计](./provider-audits/) | 官方能力、保守推断、适用日期与复审触发器 | provider或transport边界变化时 |
| [切流 Runbook](./runbooks/durable-cutover.md) | durable staging、切流、No-Go与回滚步骤 | 部署边界或门禁变化时 |
| [Vercel Preview Runbook](./runbooks/vercel-preview.md) | Vercel Web/API、外部Worker与受保护单用户Preview | 部署边界变化时 |
| [Memory retention Runbook](./runbooks/memory-retention-maintenance.md) | retention进程配置、backlog、告警和故障恢复 | retention runtime或部署边界变化时 |
| [Eval Runtime角色 Runbook](./runbooks/eval-runtime-roles.md) | dispatcher、consumer、live sampler角色部署、验证与回滚 | Eval数据库边界变化时 |

## 当前状态

- MVP已完成：Next.js Web/API、TypeScript Agent/Workflow、PostgreSQL/BullMQ durable写作主链路、恢复与失败语义及版本化Eval均有代码与回归证据；Memory不计入当前MVP验收。
- 当前发布目标是受Vercel Authentication保护的个人Preview；Web/API上Vercel，Worker在独立常驻Node环境。公开Production与正式多用户Auth仍未完成。
- 已完成：[0001 共享 contracts 基建](./iterations/0001-contracts-foundation.md)。
- 已完成：[0002 迁移 fixture 与版本 manifest](./iterations/0002-migration-fixtures.md)。
- 已完成：[0003 Next.js App Router 基础迁移](./iterations/0003-nextjs-app-router-foundation.md)。
- 已完成：[0004 Durable Job 数据层基础](./iterations/0004-durable-job-data-foundation.md)。
- 已完成：[0005 Agent Core 与 Planner/Reviewer 迁移](./iterations/0005-agent-core-planner-reviewer.md)。
- 已完成：[0006 Coverage/Research 与 Search Port](./iterations/0006-coverage-research-search-port.md)。
- 已完成：[0007 Writer 与有界 Tool Loop](./iterations/0007-writer-tool-loop.md)。
- 已完成：[0008 LangGraph Workflow Runtime](./iterations/0008-langgraph-workflow-runtime.md)。
- 已完成：[0009 Worker Lease 与 Fencing 基础](./iterations/0009-worker-lease-foundation.md)。
- 已完成：[0010 真实 PostgreSQL 与 Fenced Effects](./iterations/0010-real-postgres-and-fenced-effects.md)。
- 已完成：[0011 Postgres Checkpoint Attempt Isolation](./iterations/0011-postgres-checkpoint-attempt-isolation.md)。
- 已完成：[0012 BullMQ Outbox 与 Consumer](./iterations/0012-bullmq-outbox-consumer.md)。
- 最近完成：[0013 Durable Workflow 与 Terminal Transaction](./iterations/0013-durable-workflow-terminal-transaction.md)。
- 最近完成：[0014 Durable Reply 与 SSE Read Model](./iterations/0014-durable-reply-and-sse-read-model.md)。
- 最近完成：[0015 Durable Article Read/Write Model](./iterations/0015-durable-article-read-write-model.md)。
- 最近完成：[0016 Provider 与 Worker Composition](./iterations/0016-provider-and-worker-composition.md)。
- 最近完成：[0017 Fenced Provider Effects](./iterations/0017-fenced-provider-effects.md)。
- 最近完成：[0018 Production Composition E2E](./iterations/0018-production-composition-e2e.md)。
- 最近完成：[0019 Readiness 与切流控制](./iterations/0019-readiness-and-cutover-controls.md)。
- 最近完成：[0020 Legacy SQLite Article Migration](./iterations/0020-legacy-sqlite-article-migration.md)。
- 最近完成：[0021 Self-owned Eval 与 Run Trace](./iterations/0021-self-owned-eval-and-run-trace.md)。
- 最近完成：[0022 版本化组件 Eval Baseline Gate](./iterations/0022-component-eval-baseline-gate.md)。
- 最近完成：[0023 跨运行时 Workflow Shadow Gate](./iterations/0023-cross-runtime-workflow-shadow-gate.md)。
- 最近完成：[0024 Durable Production Projection Gate](./iterations/0024-durable-production-projection-gate.md)。
- 最近完成：[0025 Workspace Identity 与 RLS 基础](./iterations/0025-workspace-identity-and-rls-foundation.md)。
- 最近完成：[0026 Production Outline Resume Projection Gate](./iterations/0026-production-outline-resume-projection-gate.md)。
- 最近完成：[0027 Production Running Cancellation Projection Gate](./iterations/0027-production-running-cancellation-projection-gate.md)。
- 最近完成：[0028 Production Provider Failure Projection Gate](./iterations/0028-production-provider-failure-projection-gate.md)。
- 最近完成：[0029 Production Expired-Lease Takeover Projection Gate](./iterations/0029-production-expired-lease-takeover-projection-gate.md)。
- 最近完成：[0030 Independent Durable Eval Queue](./iterations/0030-independent-durable-eval-queue.md)。
- 最近完成：[0031 Live Eval Candidate Governance Foundation](./iterations/0031-live-eval-candidate-governance-foundation.md)。
- 最近完成：[0032 Automatic Live Eval Sampling](./iterations/0032-automatic-live-eval-sampling.md)。
- 最近完成：[0033 Approved Live Eval Materialization](./iterations/0033-approved-live-eval-materialization.md)。
- 最近完成：[0034 Versioned Model Grader 与 Cost Budget](./iterations/0034-versioned-model-grader-and-cost-budget.md)。
- Production backlog：[0035 Content-free CI Eval Artifact](./iterations/0035-content-free-ci-eval-artifact.md)的本地contract已通过，真实GitHub-hosted run留待实际发布时验证，不阻塞MVP。
- 最近完成：[0036 Versioned Memory Policy Kernel](./iterations/0036-versioned-memory-policy-kernel.md)。
- 最近完成：[0037 Durable Memory Governance Foundation](./iterations/0037-durable-memory-governance-foundation.md)，建立 workspace-scoped persistence、review、revision、RLS 与 erasure 基线。
- 最近完成：[0038 Deterministic Memory Governance Eval](./iterations/0038-deterministic-memory-governance-eval.md)；R6 下一步进入 extractor contract/Worker、expiry scheduler 和真实 should-write calibration。
- 最近完成：[0039 Trusted-envelope Memory Extraction Contract](./iterations/0039-trusted-envelope-memory-extraction-contract.md)，固定model output与trusted runtime envelope边界。
- 最近完成：[0040 Scripted Memory Extraction Delivery](./iterations/0040-scripted-memory-extraction-delivery.md)；R6 下一步进入 provider effect ledger、extractor calibration和受控production composition。
- 最近完成：[0041 Fenced Memory Extraction Effects](./iterations/0041-fenced-memory-extraction-effects.md)，建立独立task/attempt/effect账本、DB lease/heartbeat、content-free usage/cost计量和unknown-outcome fail-closed。
- 最近完成：[0042 Provenance-aware Memory Extraction Calibration](./iterations/0042-provenance-aware-memory-extraction-calibration.md)，建立versioned prompt/adapter、trusted author/scope source、24-case quality gate，并确认当前task topic与assistant article不能作为长期Memory来源；下一步先建立显式user-authored durable signal，再做真实model/cost calibration。
- 最近完成：[0043 Explicit User-authored Memory Source Signals](./iterations/0043-explicit-user-memory-source-signals.md)，建立独立signal/tombstone、显式consent、subject权限、幂等、retention、作者/owner删除和真实RLS。
- 最近完成：[0044 Typed Memory Evidence Sources](./iterations/0044-typed-memory-evidence-sources.md)，将proposal/candidate升级为`run | signal`严格source，重验signal可信事实，并以数据库级联清除candidate/event/active Memory/revision；下一步迁移extraction ledger与queue identity。
- 最近完成：[0045 Typed Memory Extraction Delivery](./iterations/0045-typed-memory-extraction-delivery.md)，将ledger/outbox/BullMQ迁到typed source，并为signal删除与in-flight provider effect建立cancelled/uncertain fencing；下一步进入真实model/cost calibration与reconciliation设计。
- 最近完成：[0046 Durable Memory Cost Budget](./iterations/0046-durable-memory-cost-budget.md)，以versioned pricing、effect reservation和PostgreSQL workspace锁建立调用前source/UTC日hard cap；下一步进入`uncertain` reconciliation。
- 最近完成：[0047 Owner-controlled Memory Reconciliation](./iterations/0047-owner-controlled-memory-reconciliation.md)，为`uncertain` effect建立owner-only evidence、append-only audit、actual cost settlement和有界requeue；下一步建立provider lookup port，并用真实模型/账单样本校准质量与成本。
- 最近完成：[0048 Provider-neutral Memory Request Lookup](./iterations/0048-provider-neutral-memory-request-lookup.md)，以strict terminal evidence、snapshot cost、完整reservation policy校验和网络/事务分离建立可替换lookup边界；下一步审计真实provider evidence能力并建立付费quality/cost calibration dataset。
- 最近完成：[0049 Provider Dual Identity 与 Calibration Readiness](./iterations/0049-provider-dual-identity-and-calibration-readiness.md)，纠正HTTP request与Message response identity，并以24-case/72-call tracked plan建立offline No-Go门禁；下一步需显式选择model、pricing snapshot与cost cap后才能实现并授权付费shadow runner。
- 最近完成：[0050 Memory Calibration Bound Execution](./iterations/0050-memory-calibration-bound-execution.md)，建立exact cost quote、immutable approval binding、provider-neutral 72-trial runner和故障熔断；真实model与付费调用仍未授权，下一步把execution/approval接入durable Eval数据平面。
- 最近完成：[0051 Durable Memory Calibration Authorization](./iterations/0051-durable-memory-calibration-authorization.md)，把owner approval、execution snapshot与append-only audit落入PostgreSQL，并原子接入既有Eval run/outbox/Worker；真实model、pricing与付费运行仍需单独人工授权。
- 最近完成：[0052 Durable Memory Retention Maintenance](./iterations/0052-durable-memory-retention-maintenance.md)，把DB-time expiry升级为独立DB-only进程，支持有界backlog、多实例`SKIP LOCKED`、health与结构化告警；production最小权限DB role和托管告警仍待部署。
- 最近完成：[0053 Versioned Memory Consent Staging API](./iterations/0053-versioned-memory-consent-staging-api.md)，以共享契约、独立feature flag、服务端policy version与必填幂等键开放默认关闭的user-authored signal入口；真实PostgreSQL RLS、根级回归与Next production build均已通过。
- 最近完成：[0054 Durable Memory Management Staging API](./iterations/0054-durable-memory-management-staging-api.md)，以独立feature flag开放active read、candidate audit/review和owner hard delete，并以有界cursor、workspace-leading index、真实PostgreSQL逐页集合核对和最小DTO保持扩展性与既有角色矩阵。
- 最近完成：[0055 Versioned Memory Policy 与 Management UI](./iterations/0055-versioned-memory-policy-and-management-ui.md)，用append-only policy registry、服务端role capability、signal cursor/index和Server-first并行bootstrap组成默认关闭的`/memory`治理入口；真实PostgreSQL分页/RLS与根级回归均已通过。
- 最近完成：[0056 Durable API Role 与 Memory Canary](./iterations/0056-durable-api-role-and-memory-canary.md)，以精确有效权限verifier、专用非owner连接、真实Next和header-stripping proxy fixture证明Memory治理部署协议；目标环境真实Auth/Ingress仍是公开切流门禁。
- 最近完成：[0057 Memory Retention 独立数据库角色](./iterations/0057-memory-retention-database-role.md)，把跨workspace expiry从通用owner连接迁到精确权限、显式`BYPASSRLS`且启动时自校验的maintenance role；真实PostgreSQL与根级回归均已通过。
- 最近完成：[0058 Write Runtime 独立数据库角色](./iterations/0058-write-runtime-database-roles.md)，拆分dispatcher/consumer连接并把checkpoint DDL移出runtime；双非owner PostgreSQL/Redis projection与根级回归均已通过。
- 最近完成：[0059 Eval Runtime 独立数据库角色](./iterations/0059-eval-runtime-database-roles.md)，拆分dispatcher/consumer/live sampler连接并建立sampler列级content-free边界；真实PostgreSQL/Redis角色canary与根级回归均已通过。
- 最近完成：[0060 MVP 完成审计与范围冻结](./iterations/0060-mvp-completion-audit.md)，按产品验证而非production完备度收口重构，撤回非关键operator扩建并冻结production backlog。
- 最近完成：[0061 本地 Durable 产品切流](./iterations/0061-local-durable-product-cutover.md)，以`pnpm dev:durable`组合持久化本地PostgreSQL/Redis、最小权限角色、Next durable API与TypeScript Worker，并跑通创建、outline确认、SSE终态、文章编辑和restore。
- 最近完成：[0062 Memory 从产品 MVP 延后](./iterations/0062-defer-memory-from-product-mvp.md)，移除post-run提取副作用与核心readiness依赖；历史实现保留但不进入产品入口、启动组合或验收。
- 最近完成：[0063 Python 退役与 Vercel Preview 边界](./iterations/0063-python-retirement-and-vercel-preview.md)，删除可执行双栈与SQLite fallback，验证Vercel monorepo build并固定外部Worker边界。
- 进行中：[0064 Vercel、Neon 与外部 Worker 部署](./iterations/0064-vercel-neon-worker-deployment.md)，Neon Free schema、checkpoint、三套最小权限角色与固定workspace已就绪；等待Vercel secret写入、Preview和服务器Worker验收。

## 维护规则

1. 当前事实必须由代码、测试或运行结果支持；历史文档不能当作当前证据。
2. 每次实施必须对应一个 `iterations/NNNN-*.md`，写清范围内、范围外和验证结果。
3. 改变系统边界、数据所有权或核心技术选择时必须新增 ADR；ADR 不原地改写结论，使用新的 ADR supersede。
4. Prompt、model profile、tool schema、graph 和 eval dataset 都必须有显式版本，运行记录不能只保存“当前配置”。
5. PostgreSQL 是业务状态真相；Redis、队列和 trace 平台不能成为唯一数据源。
6. 历史迁移fixture可作为回归输入，但不得重新接回已退役运行时。
7. 文档中的 `Done` 只能在对应退出条件和验证命令均有证据时填写。

## MVP 完成定义

当前MVP已满足以下条件：

- Next.js App Router承载Web；
- TypeScript Agent/LangGraph.js、PostgreSQL、BullMQ和Worker组成可恢复写作主链路；
- 取消、人工确认、失败、lease takeover和SSE重连具有契约或集成证据；
- 共享契约、版本化配置和根级回归可重复执行；
- Python/FastAPI兼容运行时已经删除；回滚只使用TypeScript artifact与PostgreSQL备份。

## Production 完成定义（非 MVP）

以下是未来公开生产切流的完成条件，不是当前MVP门槛：

- Web 已由 Next.js App Router 承载；
- 写作工作流由 TypeScript/LangGraph.js Worker 承载；
- job、事件、checkpoint、文章和版本具备持久化与恢复能力；
- 人工确认、取消、SSE 重连和失败重试有集成测试；
- 迁移行为基准、离线 eval 和线上 trace 闭环可运行；
- 如未来重新引入memory，另行定义作用域、来源、删除、冲突和评测能力；
- Vercel Preview与外部Worker连接到同一PostgreSQL，并完成受保护的产品smoke。
