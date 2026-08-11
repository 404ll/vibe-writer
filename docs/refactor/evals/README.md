# 重构评测记录

本目录记录 Python → TypeScript 迁移期间可重复执行的 component/e2e eval 结果。它不是测试代码的替代品，而是把 dataset、实现版本、已知差异、命令证据和结论固定在一起。

每份记录至少包含：

- dataset id 与 schema version；
- compatibility baseline 和 target implementation；
- prompt/model/graph/tool/code version 中当前适用的部分；
- 确定性指标、主观 grader 指标或明确说明尚未执行；
- intentional delta、regression 与 inconclusive 的区分；
- 可重跑命令和运行环境边界。

没有真实模型或固定 grader 的结果，不得声称文章质量等价。fixture 通过只证明被覆盖的确定性行为和显式差异。

## 记录

- [0001 Planner/Reviewer 确定性基线](./0001-planner-reviewer-deterministic-baseline.md)
- [0002 Coverage/Research 确定性基线](./0002-coverage-research-deterministic-baseline.md)
- [0003 Writer/Tool Loop 确定性基线](./0003-writer-tool-loop-deterministic-baseline.md)
- [0004 Workflow Runtime 确定性基线](./0004-workflow-runtime-deterministic-baseline.md)
- [0005 Worker Lease 故障基线](./0005-worker-lease-fault-baseline.md)
- [0006 真实 PostgreSQL 与 Fenced Effects 基线](./0006-real-postgres-fenced-effects-baseline.md)
- [0007 Postgres Checkpoint Attempt 基线](./0007-postgres-checkpoint-attempt-baseline.md)
- [0008 BullMQ Delivery 基线](./0008-bullmq-delivery-baseline.md)
- [0009 Durable Terminal 基线](./0009-durable-terminal-baseline.md)
- [0010 Durable Reply/SSE 基线](./0010-durable-reply-sse-baseline.md)
- [0011 Durable Article Revision 基线](./0011-durable-article-revision-baseline.md)
- [0012 Provider/Worker Process 基线](./0012-provider-worker-process-baseline.md)
- [0013 Fenced Provider Effects 基线](./0013-fenced-provider-effects-baseline.md)
- [0014 Production Composition 联合基线](./0014-production-composition-baseline.md)
- [0015 Readiness 与切流控制基线](./0015-readiness-cutover-baseline.md)
- [0016 Legacy SQLite Migration 基线](./0016-legacy-sqlite-migration-baseline.md)
- [0017 Self-owned Eval 与 Run Trace 基线](./0017-self-owned-eval-trace-baseline.md)
- [0018 组件回归 Gate 基线](./0018-component-regression-gate-baseline.md)
- [0019 跨运行时 Workflow Shadow 基线](./0019-cross-runtime-workflow-shadow-baseline.md)
- [0020 Durable Production Projection 基线](./0020-durable-production-projection-baseline.md)
- [0021 Workspace Isolation 基线](./0021-workspace-isolation-baseline.md)
- [0022 Production Outline Resume 基线](./0022-production-outline-resume-baseline.md)
- [0023 Production Running Cancellation 基线](./0023-production-running-cancellation-baseline.md)
- [0024 Production Provider Failure 基线](./0024-production-provider-failure-baseline.md)
- [0025 Production Expired-Lease Takeover 基线](./0025-production-expired-lease-takeover-baseline.md)
- [0026 Independent Durable Eval Queue 基线](./0026-independent-durable-eval-queue-baseline.md)
- [0027 Live Eval Candidate Governance 基线](./0027-live-eval-candidate-governance-baseline.md)
- [0028 Automatic Live Eval Sampling 基线](./0028-automatic-live-eval-sampling-baseline.md)
- [0029 Approved Live Eval Materialization 基线](./0029-approved-live-eval-materialization-baseline.md)
- [0030 Versioned Model Grader 工程基线](./0030-versioned-model-grader-baseline.md)
- [0031 Content-free CI Artifact 本地基线](./0031-content-free-ci-artifact-baseline.md)
- [0032 Memory Policy Kernel 基线](./0032-memory-policy-kernel-baseline.md)
- [0033 Durable Memory Governance 基线](./0033-durable-memory-governance-baseline.md)
- [0034 Deterministic Memory Governance 基线](./0034-deterministic-memory-governance-baseline.md)
- [0035 Trusted-envelope Memory Extraction Contract 基线](./0035-memory-extraction-contract-baseline.md)
- [0036 Scripted Memory Delivery 基线](./0036-scripted-memory-delivery-baseline.md)
- [0037 Fenced Memory Extraction 基线](./0037-fenced-memory-extraction-baseline.md)
- [0038 Memory Extraction Quality 基线](./0038-memory-extraction-quality-baseline.md)
- [0039 Memory Source Signal 工程基线](./0039-memory-source-signal-baseline.md)
- [0040 Typed Memory Source 与 Erasure 基线](./0040-typed-memory-source-erasure-baseline.md)
- [0041 Typed Memory Delivery 故障基线](./0041-typed-memory-delivery-fault-baseline.md)
- [0042 Memory Cost Budget 故障基线](./0042-memory-cost-budget-fault-baseline.md)
- [0043 Memory Reconciliation 故障基线](./0043-memory-reconciliation-fault-baseline.md)
- [0044 Memory Provider Lookup 故障基线](./0044-memory-provider-lookup-fault-baseline.md)
- [0045 Memory Calibration Readiness 基线](./0045-memory-calibration-readiness-baseline.md)
- [0046 Memory Calibration Execution 工程基线](./0046-memory-calibration-execution-baseline.md)
- [0047 Durable Memory Calibration Authorization 工程基线](./0047-durable-memory-calibration-authorization-baseline.md)
- [0048 Memory Retention Maintenance 工程基线](./0048-memory-retention-maintenance-baseline.md)
- [0049 Memory Consent Staging API 工程基线](./0049-memory-consent-staging-api-baseline.md)
- [0050 Memory Management Staging API 工程基线](./0050-memory-management-staging-api-baseline.md)
- [0051 Memory Policy 与 Management UI 工程基线](./0051-memory-policy-management-ui-baseline.md)
- [0052 Durable API Role 与 Memory Canary 工程基线](./0052-durable-api-role-memory-canary-baseline.md)
- [0053 Memory Retention Role Canary 工程基线](./0053-memory-retention-role-canary-baseline.md)
- [0054 Write Runtime Role Canary 工程基线](./0054-write-runtime-role-canary-baseline.md)
- [0055 Eval Runtime Role Canary 工程基线](./0055-eval-runtime-role-canary-baseline.md)
