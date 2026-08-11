# ADR-0067：Writer 为推理 token 保留输出余量

- 状态：Accepted
- 日期：2026-08-11
- 关联：[ADR-0017](./0017-provider-adapters-and-worker-process-boundary.md)、[ADR-0066](./0066-single-user-consumer-principal-scope.md)

## 背景

真实Preview验收中，200字与600字的单章节任务都能完成Planner、Coverage和模型请求，但Writer连续两次收到`max_tokens`并按有界重试策略终止。当前兼容模型会把内部推理计入`max_tokens`；旧公式对小章节最低只给512 token，即使正文目标很短，也可能在正文完成前耗尽输出预算。

## 决定

1. Writer请求继续按章节目标词数乘以2.2计算输出上限。
2. 最小输出上限从512提高到4096，最大上限仍为8192。
3. 正文长度继续由版本化提示词与Reviewer约束；`max_tokens`只是单次请求的安全上限，不是要求模型实际输出的长度。
4. 两次Writer尝试和工具调用总预算保持不变，不放开无限重试。
5. 每次运行的`codeRevision`与effect request fingerprint继续记录本次策略，后续Eval可以区分不同实现版本。

## 取舍

- 兼容推理模型获得足够余量，小章节不会因内部推理提前截断。
- 单次调用的理论最大费用上升，但模型正常结束时只按实际token计费；8192硬上限继续限制最坏情况。
- 如果未来固定使用不消耗推理token的模型，可通过Eval重新下调，不在运行时按供应商名称写隐式分支。

## 回滚

把最小上限恢复为512，并切回已验证不会把推理计入输出预算的模型配置。回滚前必须通过真实Writer任务和组件Eval。
