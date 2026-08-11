import { z } from 'zod'
import { ReviewResultSchema, WorkflowStageSchema } from './jobs'

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

export const SSE_EVENT_TYPES = [
  ...SSE_EVENT_GROUPS.lifecycle,
  ...SSE_EVENT_GROUPS.planning,
  ...SSE_EVENT_GROUPS.chapter,
  ...SSE_EVENT_GROUPS.review,
] as const satisfies readonly SSEEventType[]

export const SSEEventTypeSchema = z.enum(SSE_EVENT_TYPES)
export const TERMINAL_EVENTS: ReadonlySet<SSEEventType> = new Set(SSE_EVENT_GROUPS.lifecycle)

// 组件级事件在进入数据库前可以没有 `_seq`；持久化后的事件由数据仓储分配
// 单调递增序号，供服务端推送重放和前端去重。可选性只服务这两个生命周期阶段。
const sequenced = <T extends z.ZodRawShape>(shape: T) =>
  z.object({
    ...shape,
    _seq: z.number().int().nonnegative().optional(),
  })

const title = { title: z.string() }
const reviewWithTitleSchema = ReviewResultSchema.extend({ title: z.string() })

export const JobEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('stage_update'),
    data: sequenced({ stage: WorkflowStageSchema }),
  }),
  z.object({
    event: z.literal('outline_ready'),
    data: sequenced({ outline: z.array(z.string()) }),
  }),
  z.object({ event: z.literal('generating_opinions'), data: sequenced(title) }),
  z.object({ event: z.literal('opinions_ready'), data: sequenced(title) }),
  z.object({
    event: z.literal('searching'),
    data: sequenced({
      ...title,
      query: z.string(),
      index: z.number().int().positive(),
    }),
  }),
  z.object({
    event: z.literal('search_done'),
    data: sequenced({
      ...title,
      query: z.string(),
      preview: z.string(),
      chars: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    event: z.literal('writing_chapter'),
    data: sequenced({ ...title, token: z.string() }),
  }),
  z.object({ event: z.literal('reviewing_chapter'), data: sequenced(title) }),
  z.object({
    event: z.literal('chapter_done'),
    data: sequenced({ ...title, review: ReviewResultSchema }),
  }),
  z.object({ event: z.literal('reviewing_full'), data: sequenced({}) }),
  z.object({
    event: z.literal('review_done'),
    data: sequenced({ results: z.array(reviewWithTitleSchema) }),
  }),
  z.object({
    event: z.literal('done'),
    data: sequenced({
      output_path: z.string().nullable(),
      article_id: z.string().min(1),
    }),
  }),
  z.object({ event: z.literal('cancelled'), data: sequenced({}) }),
  z.object({
    event: z.literal('error'),
    data: sequenced({ message: z.string() }),
  }),
])

export const EventHistoryResponseSchema = z.object({
  events: z.array(JobEventSchema),
})

export type JobEvent = z.infer<typeof JobEventSchema>
export type EventHistoryResponse = z.infer<typeof EventHistoryResponseSchema>
export type JobEventData<TEvent extends SSEEventType> = Extract<
  JobEvent,
  { event: TEvent }
>['data']
