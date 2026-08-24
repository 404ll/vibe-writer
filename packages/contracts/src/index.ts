/**
 * `@vibe-writer/contracts` 的公共总入口。
 *
 * 它方便测试和工具一次性访问全部契约；生产代码通常应优先从
 * `@vibe-writer/contracts/jobs`、`/sse`、`/articles` 等子路径导入，
 * 这样能直接看出依赖的是哪一条协议，也避免把无关 fixture 带进依赖图。
 */

// 产品主链路：文章 CRUD、任务命令、SSE 事件与搜索结果。
export * from './articles'
export * from './jobs/commands'
export * from './research'
export * from './jobs/sse'

// Memory 管理链路：策略、显式信号和管理接口。
export * from './memory/management'
export * from './memory/policy'
export * from './memory/signals'

// Eval/回归基线：固定某次组件或生产投影的输入输出，不承载产品业务逻辑。
export * from './eval/agent-component-fixtures'
export * from './eval/production-composition-fixtures'
export * from './eval/production-cancellation-fixtures'
export * from './eval/production-failure-fixtures'
export * from './eval/production-takeover-fixtures'
export * from './eval/research-component-fixtures'
export * from './eval/writer-component-fixtures'
export * from './eval/workflow-component-fixtures'
export * from './eval/workflow-shadow-fixtures'
