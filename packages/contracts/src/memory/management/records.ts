import { z } from 'zod'
import { MemorySubjectSchema } from '../signals'
import {
  MEMORY_DELETE_REASONS,
  MemoryKeySchema,
  MemoryKindSchema,
  MemoryManagementTimestampSchema,
} from './shared'

/** 已经生效、可以被产品读取和删除的长期记忆记录。 */
export const ActiveMemorySchema = z.object({
  id: z.uuid(),
  subject: MemorySubjectSchema,
  memory_key: MemoryKeySchema,
  kind: MemoryKindSchema,
  content: z.string().min(1).max(4_096),
  current_revision: z.number().int().positive(),
  expires_at: MemoryManagementTimestampSchema,
  created_at: MemoryManagementTimestampSchema,
  updated_at: MemoryManagementTimestampSchema,
}).strict()

export const ListActiveMemoriesResponseSchema = z.object({
  memories: z.array(ActiveMemorySchema),
  next_cursor: z.string().min(1).max(1_024).nullable(),
}).strict()

/** 删除必须记录治理原因，不能只根据 ID 直接抹除。 */
export const DeleteMemoryRequestSchema = z.object({
  reason_code: z.enum(MEMORY_DELETE_REASONS),
}).strict()

/** replayed 让客户端区分首次删除和幂等重放，两者都可视为成功。 */
export const DeleteMemoryResponseSchema = z.object({
  status: z.literal('deleted'),
  memory_id: z.uuid(),
  reason_code: z.enum(MEMORY_DELETE_REASONS),
  deleted_at: MemoryManagementTimestampSchema,
  replayed: z.boolean(),
}).strict()

export type ActiveMemory = z.infer<typeof ActiveMemorySchema>
export type DeleteMemoryRequest = z.infer<typeof DeleteMemoryRequestSchema>
export type DeleteMemoryResponse = z.infer<typeof DeleteMemoryResponseSchema>
