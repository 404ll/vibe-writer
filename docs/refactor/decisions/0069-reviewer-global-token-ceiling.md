# ADR-0069：Reviewer 使用全局 token 硬上限

- 状态：Accepted
- 日期：2026-08-11
- 取代：[ADR-0068](./0068-reviewer-thinking-token-headroom.md)

## 背景

ADR-0068把Reviewer上限从1024提高到4096。真实复验中，第一次Chapter Review合法返回“不通过”并触发Writer重写；第二次Writer成功，但第二次Review再次精确输出4096 token并以`finishReason=length`结束。4096仍不足以覆盖当前兼容模型的内部推理。

## 决定

1. Chapter与Full Reviewer统一使用8192 token，即当前模型请求的全局硬上限。
2. Reviewer仍只接受Zod Schema验证通过的JSON；截断、缺字段或类型错误继续返回`inconclusive`。
3. Writer重写次数、工作流重试次数和工具预算全部保持不变。
4. 不按模型名称设置隐式分支；实际usage与finish reason继续写入effect metadata，供后续Eval重新校准。

## 取舍

- 为推理模型提供最大可用余量，避免第二次Review因额度耗尽而浪费前序Writer调用。
- 理论费用上限提高，但Reviewer要求短JSON，正常结束仍按实际token计费。
- 如果8192仍被耗尽，MVP保持fail-closed并报告模型不兼容，不再继续扩大额度或无限重试。

## 回滚

切换到经真实任务验证的模型后，可以用Eval证据下调Reviewer额度；没有证据时不得恢复4096。
