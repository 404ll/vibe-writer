import { z } from 'zod'

/**
 * SSE 事件词表与生命周期语义。
 *
 * 这个文件只回答“有哪些事件、哪些事件会结束任务”；每种事件携带的 data
 * 由 `events.ts` 定义。前端事件分发与服务端 stream 关闭判断依赖这里。
 */

/** 按前端工作区的处理职责分组；分组本身不改变事件在线路上的格式。 */
export const SSE_EVENT_GROUPS = {
  lifecycle: ['done', 'cancelled', 'error'],
  planning: ['stage_update', 'outline_ready'],
  chapter: [
    'generating_opinions',
    'opinions_ready',
    'searching',
    'search_done',
    'writing_chapter',
    'reviewing_chapter',
    'chapter_done',
  ],
  review: ['reviewing_full', 'review_done'],
} as const

export type JobLifecycleEvent = (typeof SSE_EVENT_GROUPS.lifecycle)[number]
export type PlanningEvent = (typeof SSE_EVENT_GROUPS.planning)[number]
export type ChapterEvent = (typeof SSE_EVENT_GROUPS.chapter)[number]
export type ReviewEvent = (typeof SSE_EVENT_GROUPS.review)[number]
export type SSEEventType = JobLifecycleEvent | PlanningEvent | ChapterEvent | ReviewEvent

/** 所有合法事件名的运行时白名单，也是 Zod enum 的唯一来源。 */
export const SSE_EVENT_TYPES = [
  ...SSE_EVENT_GROUPS.lifecycle,
  ...SSE_EVENT_GROUPS.planning,
  ...SSE_EVENT_GROUPS.chapter,
  ...SSE_EVENT_GROUPS.review,
] as const satisfies readonly SSEEventType[]

export const SSEEventTypeSchema = z.enum(SSE_EVENT_TYPES)

/** 收到这些事件后任务不会再产生后续进度，客户端应停止重连。 */
export const TERMINAL_EVENTS: ReadonlySet<SSEEventType> = new Set(SSE_EVENT_GROUPS.lifecycle)
