import { z } from 'zod'
import {
  ListActiveMemoriesResponseSchema,
  ListMemoryCandidatesResponseSchema,
} from './memory-management'
import {
  ListMemorySignalsResponseSchema,
  MemoryConsentPolicyVersionSchema,
  MemorySourceSignalKindSchema,
  MemorySubjectSchema,
} from './memory-signals'

export const MEMORY_WORKSPACE_ROLES = ['viewer', 'editor', 'owner'] as const

const PolicyTextSchema = z.string().trim().min(1).max(1_000)

export const MemoryConsentPolicyDocumentSchema = z.object({
  schema_version: z.literal(1),
  version: MemoryConsentPolicyVersionSchema,
  title: z.string().trim().min(1).max(120),
  summary: PolicyTextSchema,
  statements: z.array(z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/u),
    title: z.string().trim().min(1).max(120),
    description: PolicyTextSchema,
  }).strict()).min(1).max(12),
  retention: z.object({
    minimum_days: z.number().int().min(1).max(365),
    default_days: z.number().int().min(1).max(365),
    maximum_days: z.number().int().min(1).max(365),
  }).strict().refine(
    ({ minimum_days, default_days, maximum_days }) =>
      minimum_days <= default_days && default_days <= maximum_days,
    { message: 'Memory consent retention bounds are inconsistent' },
  ),
  allowed_signal_kinds: z.array(MemorySourceSignalKindSchema).min(1),
}).strict()

export const MemoryManagementCapabilitiesSchema = z.object({
  read_active_memories: z.boolean(),
  review_candidates: z.boolean(),
  delete_active_memories: z.boolean(),
  manage_own_signals: z.boolean(),
  create_shared_signals: z.boolean(),
}).strict()

export const MemorySignalSubjectOptionSchema = z.object({
  subject: MemorySubjectSchema,
  label: z.string().trim().min(1).max(120),
}).strict()

export const MemoryPolicyAccessResponseSchema = z.object({
  policy: MemoryConsentPolicyDocumentSchema,
  workspace: z.object({
    role: z.enum(MEMORY_WORKSPACE_ROLES),
    capabilities: MemoryManagementCapabilitiesSchema,
    signal_subjects: z.array(MemorySignalSubjectOptionSchema).max(16),
  }).strict(),
}).strict()

export const MemoryManagementBootstrapResponseSchema = MemoryPolicyAccessResponseSchema.extend({
  active: ListActiveMemoriesResponseSchema,
  signals: ListMemorySignalsResponseSchema,
  candidates: ListMemoryCandidatesResponseSchema,
}).strict()

export type MemoryConsentPolicyDocument = z.infer<typeof MemoryConsentPolicyDocumentSchema>
export type MemoryManagementCapabilities = z.infer<typeof MemoryManagementCapabilitiesSchema>
export type MemoryPolicyAccessResponse = z.infer<typeof MemoryPolicyAccessResponseSchema>
export type MemoryManagementBootstrapResponse = z.infer<
  typeof MemoryManagementBootstrapResponseSchema
>
