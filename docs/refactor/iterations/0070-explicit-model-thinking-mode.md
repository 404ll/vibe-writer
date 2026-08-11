# Iteration 0070：显式模型推理模式

- 日期：2026-08-11
- 状态：In progress

## 问题

DeepSeek V4 Flash默认thinking持续耗尽Writer与Reviewer输出预算。扩大到8192仍无法完成Full Review，证明应控制模型模式而不是继续放大业务额度。

## 本次范围

- Provider请求支持显式thinking mode。
- Worker校验并传递`ANTHROPIC_THINKING_MODE`。
- 模型profile记录thinking模式。
- 恢复Writer与Reviewer原有有界token预算。
- 补充测试、中文说明、ADR与真实Preview验收。

## 验证

尚未完成。只有Provider、Agent Core、Worker测试和真实Article生成通过后，才能标记为`Done`。
