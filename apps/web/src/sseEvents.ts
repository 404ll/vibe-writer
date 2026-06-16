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

export type JobLifecycleEvent = typeof SSE_EVENT_GROUPS.lifecycle[number]
export type PlanningEvent = typeof SSE_EVENT_GROUPS.planning[number]
export type ChapterEvent = typeof SSE_EVENT_GROUPS.chapter[number]
export type ReviewEvent = typeof SSE_EVENT_GROUPS.review[number]

export type SSEEventType =
  | JobLifecycleEvent
  | PlanningEvent
  | ChapterEvent
  | ReviewEvent

export const SSE_EVENT_TYPES = [
  ...SSE_EVENT_GROUPS.lifecycle,
  ...SSE_EVENT_GROUPS.planning,
  ...SSE_EVENT_GROUPS.chapter,
  ...SSE_EVENT_GROUPS.review,
] as const satisfies readonly SSEEventType[]

// 收到这些事件后，说明任务已经结束，可以主动关闭 SSE 长连接。
export const TERMINAL_EVENTS: ReadonlySet<SSEEventType> = new Set(SSE_EVENT_GROUPS.lifecycle)
