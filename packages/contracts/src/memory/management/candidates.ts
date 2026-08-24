import { z } from 'zod'
import { MemorySubjectSchema } from '../signals'
import {
  MEMORY_EVIDENCE_SOURCE_KINDS,
  MEMORY_MATERIALIZE_REASONS,
  MEMORY_PROPOSERS,
  MEMORY_REJECTION_REASONS,
  MEMORY_SENSITIVITIES,
  MemoryCandidateEventTypeSchema,
  MemoryCandidateStatusSchema,
  MemoryKeySchema,
  MemoryKindSchema,
  MemoryManagementTimestampSchema,
  MemoryPolicyOutcomeSchema,
} from './shared'

/** 尚未成为活跃记忆、需要审核或等待策略处理的候选。 */
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
  expires_at: MemoryManagementTimestampSchema,
  reviewed_at: MemoryManagementTimestampSchema.nullable(),
  decision_reason_code: z.string().min(1).max(256).nullable(),
  materialized_memory_id: z.uuid().nullable(),
  materialized_revision: z.number().int().positive().nullable(),
  created_at: MemoryManagementTimestampSchema,
}).strict()

export const ListMemoryCandidatesResponseSchema = z.object({
  candidates: z.array(MemoryCandidateSchema),
  next_cursor: z.string().min(1).max(1_024).nullable(),
}).strict()

export const MemoryCandidateEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  event_type: MemoryCandidateEventTypeSchema,
  reason_code: z.string().min(1).max(256),
  created_at: MemoryManagementTimestampSchema,
}).strict()

export const ListMemoryCandidateEventsResponseSchema = z.object({
  candidate_id: z.uuid(),
  events: z.array(MemoryCandidateEventSchema),
}).strict()

/** materialize 会生成活跃记忆；reject 只关闭候选，两类决定要求不同原因码。 */
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

/** status 是判别字段，页面可以安全收窄物化、拒绝和已过期三种结果。 */
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

export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>
export type MemoryCandidateEvent = z.infer<typeof MemoryCandidateEventSchema>
export type ReviewMemoryCandidateRequest = z.infer<typeof ReviewMemoryCandidateRequestSchema>
export type ReviewMemoryCandidateResponse = z.infer<typeof ReviewMemoryCandidateResponseSchema>
