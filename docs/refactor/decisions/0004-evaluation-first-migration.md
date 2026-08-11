# ADR-0004：使用评测基线驱动 Agent 迁移

- 状态：Accepted
- 日期：2026-08-07

## 背景

LLM 输出非确定，单元测试通过不能证明 Python 到 TypeScript 迁移没有质量退化。Prompt、模型、tool loop 和 review fallback 的细微变化都会改变结果。

## 决定

在迁移 Agent 组件之前建立版本化 fixture 和最小 eval harness。所有组件迁移同时记录模型、prompt、graph、tool、dataset 和代码版本，并比较确定性指标和固定 rubric 分数。

## 结果

- R1 必须捕获当前 API/SSE 和代表性 Agent 行为；
- 每个组件先通过独立 eval，再进入新图；
- 生产失败样本可以去标识化后回灌 dataset；
- grader 失败不能自动等同于业务通过；
- Langfuse 是观察与比较工具，自有 dataset 必须可以导出和版本化。

## 未选择

- 迁移完成后人工试写几篇再判断：不可重复，也无法定位退化节点。
- 只使用 LLM-as-a-Judge：成本高、波动大，且无法替代确定性约束。
