/**
 * 兼容入口：既有消费者仍可从 `@vibe-writer/contracts/sse` 获取全部任务事件契约。
 * 新代码只需要事件名和终止语义时使用 `/jobs/event-types`，需要 payload Schema
 * 时使用 `/jobs/events`，避免把传输词表与业务载荷重新耦合。
 */
export * from './event-types'
export * from './events'
