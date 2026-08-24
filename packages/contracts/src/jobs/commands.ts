import { z } from 'zod'

/**
 * 任务命令与状态契约。
 *
 * 数据从 Web Route Handler 进入，经过 PostgreSQL/BullMQ 交给 Worker；
 * 各层复用这里的 Schema 做运行时校验，并从同一 Schema 推导 TypeScript 类型。
 */

/** Worker 实际执行的四个工作流阶段，不包含任务最终状态。 */
export const WORKFLOW_STAGES = ['plan', 'write', 'review', 'export'] as const

/** 对外展示和持久化的完整任务状态，额外包含成功与失败终态。 */
export const JOB_STAGES = [...WORKFLOW_STAGES, 'done', 'error'] as const

export const WorkflowStageSchema = z.enum(WORKFLOW_STAGES)
export const StageStatusSchema = z.enum(JOB_STAGES)

/** 是否在大纲完成后暂停 Worker，等待用户确认或修改。 */
export const InterventionConfigSchema = z.object({
  on_outline: z.boolean(),
})

/** `POST /api/durable/jobs` 的请求体。 */
export const CreateJobRequestSchema = z.object({
  topic: z.string().trim().min(1),
  intervention: InterventionConfigSchema.default({ on_outline: true }),
  style: z.string().default(''),
  target_words: z.number().int().positive().nullable().optional(),
})

/** 创建任务成功后只返回稳定的任务 ID，后续状态通过 SSE 获取。 */
export const CreateJobResponseSchema = z.object({
  job_id: z.string().min(1),
})

/**
 * `POST /api/durable/jobs/:jobId/reply` 的人工确认请求。
 * `outline` 有值表示用户提交了修改后的大纲；否则 `message` 表达确认或补充意见。
 */
export const ReplyRequestSchema = z.object({
  message: z.string(),
  outline: z.array(z.string()).nullable().optional(),
})

/** 取消等无额外返回数据的命令使用统一成功响应。 */
export const StatusResponseSchema = z.object({
  status: z.literal('ok'),
})

/** 章节和全文 Reviewer 共享的最小审查结果。 */
export const ReviewResultSchema = z.object({
  passed: z.boolean(),
  feedback: z.string(),
})

// `z.input` 保留调用方可省略的默认字段；`z.infer` 表示 parse 后的完整数据。
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>
export type StageStatus = z.infer<typeof StageStatusSchema>
export type InterventionConfig = z.infer<typeof InterventionConfigSchema>
export type CreateJobRequestInput = z.input<typeof CreateJobRequestSchema>
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>
export type StatusResponse = z.infer<typeof StatusResponseSchema>
export type ReviewResult = z.infer<typeof ReviewResultSchema>
