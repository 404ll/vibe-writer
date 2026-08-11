# ADR-0063：Memory 延后到产品 MVP 之外

- 状态：Accepted
- 日期：2026-08-11
- Supersedes：ADR-0061 中将 Memory 管理列为 MVP 验收项的部分结论

## 背景

Memory 已经积累了policy、candidate、retention、API与Eval等实验性基础，但当前产品验证只需要证明长文写作主链路是否有价值。继续把Memory放在MVP架构图、readiness和任务终态副作用中，会扩大用户心智模型、启动依赖和维护面，却不影响“提交主题并得到可编辑文章”的核心闭环。

用户明确决定当前版本暂不包含Memory。因此需要区分“仓库里曾实现过的基础代码”和“当前产品承诺”。

## 决定

1. 当前产品MVP只包含写作、outline人工确认、SSE、文章读取/编辑/版本恢复以及对应durable execution。
2. `dev:durable`继续强制关闭Memory signal与management flag，不展示Memory入口，也不启动Memory dispatcher、consumer或retention进程。
3. 写作Worker完成任务时默认不创建`memory.extraction.requested` Outbox事件；只有未来显式composition传入opt-in才允许创建。
4. Durable API readiness在Memory flags关闭时只检查Job/Run/Article与身份基础表；只有显式开启Memory API时才追加Memory schema检查。
5. 已有Memory schema、packages、routes、tests和历史迭代记录暂时保留为归档基础，不从仓库物理删除，也不计入MVP能力、运行要求、项目经历或当前验收。
6. 重新启用Memory必须由具体用户场景触发，并新增ADR/iteration，重新确定source、consent、召回方式、质量Eval和成本边界。

## 取舍

- 保留代码可避免一次高风险反向迁移，也保留未来实验资产；代价是仓库仍有不属于当前产品面的模块。
- 从运行时与文档中解耦可以立刻缩小MVP心智模型；代价是全仓`pnpm verify`仍会回归归档模块，直到未来决定单独拆包或删除。

## 回滚

若真实用户反馈证明跨任务偏好或长期事实是核心需求，应新增决策重新纳入Memory，而不是只打开现有feature flag。恢复前至少要明确合法来源、用户可见控制面、注入写作图的位置和可量化Eval门槛。
