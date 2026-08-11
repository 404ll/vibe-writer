# Iteration 0069：Reviewer 全局 token 硬上限

- 日期：2026-08-11
- 状态：Superseded

## 问题

4096 token让第一次Review返回可验证结果，但重写后的第二次Review仍在额度边界截断，导致MVP无法提交Article。

## 本次范围

- Reviewer请求上限提高到8192。
- 不改变Schema、重写次数、重试次数和发布门槛。
- 补充测试、替代ADR与真实Preview验收证据。

## 验证

真实复验中两次Full Review分别输出8192与8193 token后仍以`length`结束，证明扩大额度不能解决默认thinking。该迭代由[Iteration 0070](./0070-explicit-model-thinking-mode.md)取代。
