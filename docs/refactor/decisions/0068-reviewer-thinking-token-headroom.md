# ADR-0068：Reviewer 为结构化结果保留推理 token 余量

- 状态：Accepted
- 日期：2026-08-11
- 关联：[ADR-0067](./0067-writer-thinking-token-headroom.md)

## 背景

ADR-0067让Writer完成了真实正文，但Full Reviewer两次都在精确输出1024 token后以`finishReason=length`结束，JSON没有闭合。系统因此返回`workflow_full_review_inconclusive`，没有发布未经验证的文章。当前兼容模型同样会把Reviewer内部推理计入输出预算。

## 决定

1. Chapter Reviewer与Full Reviewer的`max_tokens`统一设为4096。
2. Zod JSON Schema、缺失结果检查、确定性字数上限和两轮工作流重试保持不变。
3. 解析失败仍然是`inconclusive`，不得因为MVP而绕过Reviewer或直接发布正文。
4. 4096只是允许上限；运行仍通过usage、effect metadata与`codeRevision`记录实际调用。

## 取舍

- 推理模型可以在JSON闭合前完成内部推理，降低无效重试。
- 理论输出上限提高，但Reviewer提示只要求短JSON，正常调用按实际token计费。
- 统一额度比按供应商名称分支更简单，也保持模型适配层无业务特例。

## 回滚

恢复原额度前，必须用目标模型证明Chapter与Full Reviewer都能稳定返回完整JSON，并通过真实Preview验收。
