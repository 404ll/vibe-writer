# Iteration 0050：Memory Calibration Bound Execution

- 日期：2026-08-09
- 状态：Done
- 对应决策：[ADR-0051](../decisions/0051-memory-calibration-bound-execution.md)
- 评测记录：[Eval 0046](../evals/0046-memory-calibration-execution-baseline.md)

## 目标

把Iteration 0049的planned calibration从“知道缺什么”推进到“可quote、可绑定、可审批、默认不可执行”的完整工程契约，并用scripted model证明72-trial执行、质量计量和故障熔断。

## 范围内

- strict execution manifest和exact field inventory；
- tracked dataset/prompt/extractor/call inventory一致性校验；
- provider/model/profile/code revision与versioned pricing snapshot；
- 24×3 prompts的conservative micro-USD quote；
- immutable binding fingerprint与显式approval evidence；
- provider-neutral `TextModel` runner、hard budget settlement和双identity；
- output-free标准Eval report与跨trial quality aggregation；
- missing usage、unmetered failure、identity incomplete/drift与invalid JSON故障语义；
- quote/preflight CLI、根级gate、ADR、Iteration、Eval和系统设计同步。

## 范围外

- 不选择、保存或调用真实付费model；
- 不读取API key或环境credentials；
- 不提供会发起provider请求的CLI命令；
- 不把approval持久化到PostgreSQL，不接BullMQ durable Eval queue；
- 不做实际账单对账、production consumer、automatic uncertain resolution或管理UI；
- 不把scripted quality pass解释为真实模型Go。

## 验证

- `pnpm test:eval-graders && pnpm typecheck:eval-graders`：1个文件、5项测试与类型检查通过；
- `pnpm test:eval-cli && pnpm typecheck:eval-cli`：11个文件、46项测试与类型检查通过；
- `pnpm eval:memory-calibration:preflight`：无manifest时返回`configuration_required`且`executable=false`；
- 根级`pnpm verify`：contracts、runtime、Eval、Memory、DB、Worker、API、Web和文档门禁全部通过；
- `pnpm check:docs`：160个Markdown文件链接通过；`git diff --check`通过。

## 退出条件

1. quote覆盖精确72-call inventory并固定pricing version：满足。
2. 任意model/pricing/budget修改都会使approval fingerprint失效：满足。
3. 未审批execution在model调用前拒绝：满足。
4. scripted 72 trials不捕获output并产生完整usage/request/response计量：满足。
5. unmetered或identity不完整在第一次调用后停止继续消费预算：满足。
6. invalid JSON作为质量No-Go而不是静默target success：满足。
7. 架构、根级、文档和diff门禁通过：满足。

## 后续

1. 将approved execution snapshot和approval audit持久化到自有Eval数据平面；
2. 通过独立Eval queue composition注入Anthropic adapter与credentials；
3. 在明确model、官方pricing snapshot和最高费用后先运行quote，再由owner批准binding fingerprint；
4. 真实运行完成后对quality distribution、实际usage/cost与账单做人工Go/No-Go；
5. 在request-level terminal evidence仍不可用时，unknown outcome继续hold。
