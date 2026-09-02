/**
 * `@vibe-writer/agent-core` 的公共入口。
 *
 * 本包只回答「如何规划、研究、写作和审稿」，不回答请求从哪来、任务由谁领取、
 * 状态存在哪、具体调用哪家 SDK。生产 Worker 在外层注入模型、搜索与 effect 账本；
 * 评测则注入脚本化端口。若本包直接依赖 LangGraph、Next、BullMQ 或供应商 SDK，
 * 组件回归就无法脱离基础设施运行。
 */

export * from './coverage'
export * from './planner'
export * from './prompts'
export * from './reviewer'
export * from './reviewer-agent'
export * from './research'
export * from './tool-loop'
export * from './versions'
export * from './writer'
export * from './writer-agent'
export * from './writing-artifacts'
export * from './writing-style'
export * from './writing-schemas'
