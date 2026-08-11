import { z } from 'zod'
import { MemorySubjectSchema } from './memory-signals'

export const MEMORY_KINDS = ['preference', 'constraint', 'correction'] as const
export const MEMORY_CANDIDATE_STATUSES = [
  'pending_review',
  'materialized',
  'rejected',
  'expired',
] as const
export const MEMORY_POLICY_OUTCOMES = ['candidate', 'conflict'] as const
export const MEMORY_PROPOSERS = ['user', 'model'] as const
export const MEMORY_SENSITIVITIES = ['normal', 'sensitive'] as const
export const MEMORY_EVIDENCE_SOURCE_KINDS = ['run', 'signal'] as const
export const MEMORY_CANDIDATE_EVENT_TYPES = [
  'proposed',
  'materialized',
  'rejected',
  'expired',
] as const

export const MEMORY_MATERIALIZE_REASONS = [
  'confirmed_accurate',
  'confirmed_preference',
  'confirmed_constraint',
  'confirmed_correction',
  'confirmed_change',
] as const

export const MEMORY_REJECTION_REASONS = [
  'incorrect',
  'not_stable',
  'not_user_authored',
  'sensitive',
  'superseded',
] as const

export const MEMORY_DELETE_REASONS = [
  'user_requested_erasure',
  'incorrect',
  'superseded',
  'workspace_policy_erasure',
] as const

const MemoryKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,255}$/u)
const TimestampSchema = z.iso.datetime({ offset: true })

export const MemoryManagementPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(1_024).optional(),
}).strict()

export const MemoryKindSchema = z.enum(MEMORY_KINDS)
export const MemoryCandidateStatusSchema = z.enum(MEMORY_CANDIDATE_STATUSES)
export const MemoryPolicyOutcomeSchema = z.enum(MEMORY_POLICY_OUTCOMES)
export const MemoryCandidateEventTypeSchema = z.enum(MEMORY_CANDIDATE_EVENT_TYPES)

export const ActiveMemorySchema = z.object({
  id: z.uuid(),
  subject: MemorySubjectSchema,
  memory_key: MemoryKeySchema,
  kind: MemoryKindSchema,
  content: z.string().min(1).max(4_096),
  current_revision: z.number().int().positive(),
  expires_at: TimestampSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict()

export const ListActiveMemoriesResponseSchema = z.object({
  memories: z.array(ActiveMemorySchema),
  next_cursor: z.string().min(1).max(1_024).nullable(),
}).strict()

export const MemoryCandidateSchema = z.object({
  id: z.uuid(),
  source_kind: z.enum(MEMORY_EVIDENCE_SOURCE_KINDS),
  subject: MemorySubjectSchema,
  memory_key: MemoryKeySchema,
  kind: MemoryKindSchema,
  content: z.string().min(1).max(4_096),
  proposed_by: z.enum(MEMORY_PROPOSERS),
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum(MEMORY_SENSITIVITIES),
  consent: z.union([
    z.object({
      basis: z.literal('explicit_user'),
      policy_version: z.string().trim().min(1).max(256),
    }).strict(),
    z.object({
      basis: z.literal('workspace_policy'),
      policy_version: z.string().trim().min(1).max(256),
    }).strict(),
  ]),
  extractor: z.object({
    key: z.string().trim().min(1).max(256),
    version: z.string().trim().min(1).max(256),
  }).strict(),
  policy_version: z.string().trim().min(1).max(256),
  policy_outcome: MemoryPolicyOutcomeSchema,
  status: MemoryCandidateStatusSchema,
  expires_at: TimestampSchema,
  reviewed_at: TimestampSchema.nullable(),
  decision_reason_code: z.string().min(1).max(256).nullable(),
  materialized_memory_id: z.uuid().nullable(),
  materialized_revision: z.number().int().positive().nullable(),
  created_at: TimestampSchema,
}).strict()

export const ListMemoryCandidatesResponseSchema = z.object({
  candidates: z.array(MemoryCandidateSchema),
  next_cursor: z.string().min(1).max(1_024).nullable(),
}).strict()

export const MemoryCandidateEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  event_type: MemoryCandidateEventTypeSchema,
  reason_code: z.string().min(1).max(256),
  created_at: TimestampSchema,
}).strict()

export const ListMemoryCandidateEventsResponseSchema = z.object({
  candidate_id: z.uuid(),
  events: z.array(MemoryCandidateEventSchema),
}).strict()

const MaterializeMemoryCandidateRequestSchema = z.object({
  decision: z.literal('materialize'),
  reason_code: z.enum(MEMORY_MATERIALIZE_REASONS),
  replace_memory_id: z.uuid().optional(),
}).strict()

const RejectMemoryCandidateRequestSchema = z.object({
  decision: z.literal('reject'),
  reason_code: z.enum(MEMORY_REJECTION_REASONS),
}).strict()

export const ReviewMemoryCandidateRequestSchema = z.discriminatedUnion('decision', [
  MaterializeMemoryCandidateRequestSchema,
  RejectMemoryCandidateRequestSchema,
])

export const ReviewMemoryCandidateResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('materialized'),
    candidate_id: z.uuid(),
    memory_id: z.uuid(),
    current_revision: z.number().int().positive(),
    replayed: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    candidate_id: z.uuid(),
    replayed: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('expired'),
    candidate_id: z.uuid(),
  }).strict(),
])

export const DeleteMemoryRequestSchema = z.object({
  reason_code: z.enum(MEMORY_DELETE_REASONS),
}).strict()

export const DeleteMemoryResponseSchema = z.object({
  status: z.literal('deleted'),
  memory_id: z.uuid(),
  reason_code: z.enum(MEMORY_DELETE_REASONS),
  deleted_at: TimestampSchema,
  replayed: z.boolean(),
}).strict()

export type ActiveMemory = z.infer<typeof ActiveMemorySchema>
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>
export type MemoryCandidateEvent = z.infer<typeof MemoryCandidateEventSchema>
export type ReviewMemoryCandidateRequest = z.infer<typeof ReviewMemoryCandidateRequestSchema>
export type ReviewMemoryCandidateResponse = z.infer<typeof ReviewMemoryCandidateResponseSchema>
export type DeleteMemoryRequest = z.infer<typeof DeleteMemoryRequestSchema>
export type DeleteMemoryResponse = z.infer<typeof DeleteMemoryResponseSchema>
