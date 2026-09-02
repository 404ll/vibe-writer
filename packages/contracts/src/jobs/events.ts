import { z } from 'zod'
import { ReviewResultSchema, WorkflowStageSchema } from './commands'
import type { SSEEventType } from './event-types'

/**
 * 可持久化、可重放的任务事件载荷。
 *
 * Worker 产生事件 -> 数据仓储分配 `_seq` 并保存 -> Route Handler 通过历史接口或
 * SSE stream 输出 -> `useJobStream` 按 `_seq` 补齐和去重 -> 页面更新任务状态。
 */

// 组件级事件在进入数据库前可以没有 `_seq`；持久化后的事件由数据仓储分配
// 单调递增序号，供服务端推送重放和前端去重。可选性只服务这两个生命周期阶段。
const sequenced = <T extends z.ZodRawShape>(shape: T) =>
  z.object({
    ...shape,
    _seq: z.number().int().nonnegative().optional(),
  })

const title = { title: z.string() }
const reviewWithTitleSchema = ReviewResultSchema.extend({ title: z.string() })

/**
 * `event` 是判别字段：事件名确定后，TypeScript 和 Zod 都能收窄到对应的 `data`。
 * 这保证调用方不能把 `outline_ready` 的 payload 错当成章节或终止事件处理。
 */
export const JobEventSchema = z.discriminatedUnion('event', [
  // 规划阶段：阶段切换，以及等待用户确认的完整大纲。
  z.object({
    event: z.literal('stage_update'),
    data: sequenced({ stage: WorkflowStageSchema }),
  }),
  z.object({
    event: z.literal('outline_ready'),
    data: sequenced({ outline: z.array(z.string()) }),
  }),

  // 章节阶段：观点生成、检索、正文增量块和单章审查结果。
  // `token` 是兼容字段名；生产方既可以发送 provider token，也可以发送有界文本块。
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
    event: z.literal('extracting'),
    data: sequenced({
      ...title,
      url: z.url().max(2_048),
      index: z.number().int().positive(),
    }),
  }),
  z.object({
    event: z.literal('extract_done'),
    data: sequenced({
      ...title,
      url: z.url().max(2_048),
      index: z.number().int().positive(),
      source_title: z.string().max(300).optional(),
      chars: z.number().int().nonnegative(),
      status: z.enum(['ready', 'failed', 'unavailable']),
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

  // 全文审查阶段。
  z.object({ event: z.literal('reviewing_full'), data: sequenced({}) }),
  z.object({
    event: z.literal('review_done'),
    data: sequenced({ results: z.array(reviewWithTitleSchema) }),
  }),

  // 生命周期终态：成功、主动取消或失败。done 携带最终文章 ID 供页面跳转。
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

/** 页面刷新或 SSE 重连时，用历史接口批量补齐已经持久化的事件。 */
export const EventHistoryResponseSchema = z.object({
  events: z.array(JobEventSchema),
})

export type JobEvent = z.infer<typeof JobEventSchema>
export type EventHistoryResponse = z.infer<typeof EventHistoryResponseSchema>

/** 按事件名取得精确 payload，例如 `JobEventData<'done'>`。 */
export type JobEventData<TEvent extends SSEEventType> = Extract<
  JobEvent,
  { event: TEvent }
>['data']
