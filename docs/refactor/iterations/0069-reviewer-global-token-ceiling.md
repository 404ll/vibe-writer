# Iteration 0069：Reviewer 全局 token 硬上限

- 日期：2026-08-11
- 状态：In progress

## 问题

4096 token让第一次Review返回可验证结果，但重写后的第二次Review仍在额度边界截断，导致MVP无法提交Article。

## 本次范围

- Reviewer请求上限提高到8192。
- 不改变Schema、重写次数、重试次数和发布门槛。
- 补充测试、替代ADR与真实Preview验收证据。

## 验证

尚未完成。只有Agent Core测试、服务器Worker就绪和真实Article生成通过后，才能标记为`Done`。
