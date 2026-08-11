import { z } from 'zod'

export const MEMORY_SOURCE_SIGNAL_KINDS = [
  'explicit_remember',
  'preference_setting',
  'correction',
] as const

export const MEMORY_SUBJECT_KINDS = ['workspace', 'principal', 'project'] as const

export const MEMORY_SIGNAL_DELETE_REASONS = [
  'user_revoked',
  'incorrect',
  'superseded',
  'owner_removed',
] as const

export const MemorySourceSignalKindSchema = z.enum(MEMORY_SOURCE_SIGNAL_KINDS)
export const MemorySubjectKindSchema = z.enum(MEMORY_SUBJECT_KINDS)
export const MemorySignalDeleteReasonSchema = z.enum(MEMORY_SIGNAL_DELETE_REASONS)

export const MemorySignalIdempotencyKeySchema = z.string().trim().min(1).max(256)
export const MemoryConsentPolicyVersionSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)

export const MemorySubjectSchema = z.object({
  kind: MemorySubjectKindSchema,
  key: z.string().trim().min(1).max(256),
}).strict()

export const ExplicitMemoryConsentSchema = z.object({
  basis: z.literal('explicit_user'),
  policy_version: MemoryConsentPolicyVersionSchema,
}).strict()

export const MemorySignalPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(1_024).optional(),
}).strict()

export const CreateMemorySignalRequestSchema = z.object({
  source_kind: MemorySourceSignalKindSchema,
  subject: MemorySubjectSchema,
  text: z.string().trim().min(1).max(20_000),
  consent: ExplicitMemoryConsentSchema,
  retention_days: z.number().int().min(1).max(365),
  source_run_id: z.uuid().optional(),
}).strict()

export const MemorySignalSchema = z.object({
  id: z.uuid(),
  source_kind: MemorySourceSignalKindSchema,
  subject: MemorySubjectSchema,
  text: z.string().min(1).max(20_000),
  consent: ExplicitMemoryConsentSchema,
  retention_until: z.iso.datetime({ offset: true }),
  created_at: z.iso.datetime({ offset: true }),
  source_run_id: z.uuid().nullable(),
}).strict()

export const CreateMemorySignalResponseSchema = z.object({
  signal: MemorySignalSchema,
  created: z.boolean(),
}).strict()

export const ListMemorySignalsResponseSchema = z.object({
  signals: z.array(MemorySignalSchema),
  next_cursor: z.string().min(1).max(1_024).nullable(),
}).strict()

export const DeleteMemorySignalRequestSchema = z.object({
  reason_code: MemorySignalDeleteReasonSchema,
}).strict()

export const DeleteMemorySignalResponseSchema = z.object({
  status: z.literal('deleted'),
  source_signal_id: z.uuid(),
  reason_code: MemorySignalDeleteReasonSchema,
  deleted_at: z.iso.datetime({ offset: true }),
  replayed: z.boolean(),
}).strict()

export type MemorySourceSignalKind = z.infer<typeof MemorySourceSignalKindSchema>
export type MemorySubjectKind = z.infer<typeof MemorySubjectKindSchema>
export type MemorySignalDeleteReason = z.infer<typeof MemorySignalDeleteReasonSchema>
export type CreateMemorySignalRequest = z.infer<typeof CreateMemorySignalRequestSchema>
export type MemorySignal = z.infer<typeof MemorySignalSchema>
export type CreateMemorySignalResponse = z.infer<typeof CreateMemorySignalResponseSchema>
export type ListMemorySignalsResponse = z.infer<typeof ListMemorySignalsResponseSchema>
export type DeleteMemorySignalRequest = z.infer<typeof DeleteMemorySignalRequestSchema>
export type DeleteMemorySignalResponse = z.infer<typeof DeleteMemorySignalResponseSchema>
