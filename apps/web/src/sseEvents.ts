/**
 * 前端认可的 SSE `event:` 字段清单，并按工作流职责分组。
 *
 * 这份常量同时服务两个目的：
 * 1. 运行时判断后端传来的事件是否受支持；
 * 2. 编译时推导 SSEEventType，避免再手写一份容易失同步的联合类型。
 */
export const SSE_EVENT_GROUPS = {
  // 整个任务结束时产生的事件；收到后不应继续重连 SSE。
  lifecycle: ['done', 'cancelled', 'error'],
  // 大纲规划以及 plan/write/review/export 阶段切换事件。
  planning: ['stage_update', 'outline_ready'],
  // 单个章节从生成要点、搜索、写作到轻审完成的过程事件。
  chapter: [
    'generating_opinions',
    'opinions_ready',
    'searching',
    'search_done',
    'writing_chapter',
    'reviewing_chapter',
    'chapter_done',
  ],
  // 所有章节写完之后的全文审稿事件。
  review: ['reviewing_full', 'review_done'],
} as const

// `数组类型[number]` 会取出数组所有元素的字面量联合类型。
// 例如 JobLifecycleEvent 等价于 'done' | 'cancelled' | 'error'。
export type JobLifecycleEvent = typeof SSE_EVENT_GROUPS.lifecycle[number]
export type PlanningEvent = typeof SSE_EVENT_GROUPS.planning[number]
export type ChapterEvent = typeof SSE_EVENT_GROUPS.chapter[number]
export type ReviewEvent = typeof SSE_EVENT_GROUPS.review[number]

// 页面层处理 SSE 事件时使用的完整事件名联合类型。
export type SSEEventType =
  | JobLifecycleEvent
  | PlanningEvent
  | ChapterEvent
  | ReviewEvent

/**
 * 扁平化后的运行时事件白名单。
 * useJobStream.dispatch() 会用它过滤未知事件；`satisfies` 同时保证这里
 * 不会混入 SSEEventType 之外的字符串，但仍保留每个元素的字面量类型。
 */
export const SSE_EVENT_TYPES = [
  ...SSE_EVENT_GROUPS.lifecycle,
  ...SSE_EVENT_GROUPS.planning,
  ...SSE_EVENT_GROUPS.chapter,
  ...SSE_EVENT_GROUPS.review,
] as const satisfies readonly SSEEventType[]

// Set 适合反复做 O(1) 的终态判断；收到这些事件后可以主动关闭 SSE 长连接。
export const TERMINAL_EVENTS: ReadonlySet<SSEEventType> = new Set(SSE_EVENT_GROUPS.lifecycle)
