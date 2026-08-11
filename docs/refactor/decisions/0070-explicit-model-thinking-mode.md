# ADR-0070：模型推理模式必须显式配置

- 状态：Accepted
- 日期：2026-08-11
- 取代：[ADR-0067](./0067-writer-thinking-token-headroom.md)、[ADR-0069](./0069-reviewer-global-token-ceiling.md)

## 背景

真实Preview中，DeepSeek V4 Flash默认开启thinking。推理token被计入`max_tokens`，导致Writer在512/1320处截断，Full Reviewer即使提高到8192仍连续截断。继续扩大业务组件额度既不能解决问题，也会抬高费用上限。DeepSeek官方Anthropic兼容接口支持`thinking.type=enabled|disabled`，默认值为`enabled`。

## 决定

1. Provider适配器新增显式`thinkingMode`，映射到Anthropic请求体`thinking.type`。
2. Worker通过`ANTHROPIC_THINKING_MODE=enabled|disabled`配置，不根据model名称做隐式判断。
3. DeepSeek V4的结构化写作MVP固定为`disabled`。
4. Writer恢复按章节词数计算的512到8192有界额度；Chapter与Full Reviewer恢复512/1024。
5. thinking模式编码进`modelProfile.profile`，Run、Trace与后续Eval可以区分不同模型执行配置。

## 取舍

- 直接控制根因，保留完整Writer、Chapter Reviewer与Full Reviewer，不绕过质量门禁。
- 对原生Anthropic或其他兼容端点保持可选；未配置时沿用供应商默认。
- 模型profile字符串变长，但无需扩展现有持久化Schema。

## 回滚

删除`ANTHROPIC_THINKING_MODE`即可恢复供应商默认。若重新启用thinking，必须先用真实Writer和Full Reviewer证明当前token预算足够。
