# Iteration 0067：Writer 推理 token 余量

- 日期：2026-08-11
- 状态：In progress

## 问题

部署链路已经可以执行真实模型与搜索effects，但兼容模型在200字和600字任务中都把Writer请求的输出额度耗尽。系统正确拒绝残缺正文，却导致MVP无法得到终端Article。

## 本次范围

- 把Writer单次请求的最小`max_tokens`提高到4096，保留8192硬上限。
- 不改变工具预算、重试次数和正文目标词数约束。
- 补充单元测试、ADR和真实Preview验收证据。

## 验证

尚未完成。只有Agent Core测试、Worker测试、Preview重新部署以及真实Article生成通过后，才能标记为`Done`。
