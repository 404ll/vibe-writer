# Iteration 0068：Reviewer 推理 token 余量

- 日期：2026-08-11
- 状态：In progress

## 问题

Writer已能完成正文，但Full Reviewer连续两次在1024 token处截断，结构化结果无法解析。系统按fail-closed策略拒绝发布，因此MVP主路径仍未产生Article。

## 本次范围

- Chapter与Full Reviewer统一使用4096 token请求上限。
- 保留JSON Schema、字数硬限制、缺失结果检查与有界重试。
- 补充测试、ADR和真实Preview验收证据。

## 验证

尚未完成。只有Agent Core测试、服务器Worker就绪和真实Article生成通过后，才能标记为`Done`。
