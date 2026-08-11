import { z } from 'zod'

export const WORKFLOW_STAGES = ['plan', 'write', 'review', 'export'] as const
export const JOB_STAGES = [...WORKFLOW_STAGES, 'done', 'error'] as const

export const WorkflowStageSchema = z.enum(WORKFLOW_STAGES)
export const StageStatusSchema = z.enum(JOB_STAGES)

export const InterventionConfigSchema = z.object({
  on_outline: z.boolean(),
})

export const CreateJobRequestSchema = z.object({
  topic: z.string().trim().min(1),
  intervention: InterventionConfigSchema.default({ on_outline: true }),
  style: z.string().default(''),
  target_words: z.number().int().positive().nullable().optional(),
})

export const CreateJobResponseSchema = z.object({
  job_id: z.string().min(1),
})

export const ReplyRequestSchema = z.object({
  message: z.string(),
  outline: z.array(z.string()).nullable().optional(),
})

export const StatusResponseSchema = z.object({
  status: z.literal('ok'),
})

export const ReviewResultSchema = z.object({
  passed: z.boolean(),
  feedback: z.string(),
})

export type WorkflowStage = z.infer<typeof WorkflowStageSchema>
export type StageStatus = z.infer<typeof StageStatusSchema>
export type InterventionConfig = z.infer<typeof InterventionConfigSchema>
export type CreateJobRequestInput = z.input<typeof CreateJobRequestSchema>
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>
export type ReplyRequest = z.infer<typeof ReplyRequestSchema>
export type StatusResponse = z.infer<typeof StatusResponseSchema>
export type ReviewResult = z.infer<typeof ReviewResultSchema>
