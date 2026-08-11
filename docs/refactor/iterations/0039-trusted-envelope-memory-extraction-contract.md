# Iteration 0039：Trusted-envelope Memory Extraction Contract

- 日期：2026-08-07
- 状态：Done
- 对应决策：[ADR-0040](../decisions/0040-trusted-envelope-memory-extraction.md)
- 评测记录：[Eval 0035](../evals/0035-memory-extraction-contract-baseline.md)

## 目标

在接 provider 和 Worker 前，固定模型能输出什么、哪些字段只能由可信运行时注入，以及单次提取的数量和 slot 唯一性。

## 范围内

- strict/versioned model extraction output schema；
- strict trusted envelope schema；
- 最大 20 candidate batch；
- model candidate 与 workspace/source/consent/retention/extractor envelope 合成；
- `proposedBy=model` 强制绑定；
- batch 内 duplicate slot fail closed；
- 最终 `MemoryProposalSchema` 二次校验；
- provider/persistence-neutral tests。

## 范围外

- 不设计或调用 extractor prompt/model；
- 不读取 article、message、checkpoint 或完整 run transcript；
- 不实现 queue/outbox、Worker、retry、cost budget 或 repository submission；
- 不实现 evidence snippet、PII detector 或用户审核 UI；
- 不把 contract unit test描述为 should-write quality Eval。

## 验证

- `pnpm test:memory-core`：3 个文件、16 项通过；
- `pnpm typecheck:memory-core`：通过；
- `pnpm eval:memory`：既有 governance baseline 18/18，证明 contract 加入未改变 policy/review target behavior；
- `API_PYTHON=/Users/elemen/Myself/ai/vibe-writer/.venv/bin/python pnpm verify`：TypeScript 415 项、Python 50 项，共 465 项通过；component 38/38、Memory governance 18/18、workflow shadow 3/3、Web lint/test/build、全部 typecheck/migration check 和 126 个 Markdown 链接通过；
- `git diff --check`：通过。

## 退出条件

1. 模型不能控制 workspace/source/consent/expiry/proposer：满足。
2. unknown fields、invalid confidence 和超量 batch fail closed：满足。
3. batch 内同 slot 多值不按顺序覆盖：满足。
4. empty batch 可表达“无需写入”：满足。
5. 合成结果继续服从统一 proposal schema：满足。
6. core 不依赖 provider、DB、queue、graph 或 vector：满足。

## 后续

1. 定义 versioned extractor prompt 与 provider-neutral model port；
2. 建立 synthetic utterance → extraction output dataset 与 precision/recall metric；
3. 用 scripted extractor 接入 completed-run outbox/Worker；
4. 对真实 provider 做 capped、metered calibration 后才允许 shadow sampling；
5. 保持 candidate 仍需人工 review，不因 extractor 接入自动 materialize。
