import { z } from 'zod'

/**
 * Memory 管理页面、活跃记录和候选审核共同使用的枚举与基础字段。
 * 原因码使用封闭枚举，方便审计、重放和统计，而不是保存无法治理的任意文本。
 */
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

export const MemoryKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,255}$/u)
export const MemoryManagementTimestampSchema = z.iso.datetime({ offset: true })

/** 活跃记忆和候选列表共享同一种 cursor 分页请求。 */
export const MemoryManagementPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(1_024).optional(),
}).strict()

export const MemoryKindSchema = z.enum(MEMORY_KINDS)
export const MemoryCandidateStatusSchema = z.enum(MEMORY_CANDIDATE_STATUSES)
export const MemoryPolicyOutcomeSchema = z.enum(MEMORY_POLICY_OUTCOMES)
export const MemoryCandidateEventTypeSchema = z.enum(MEMORY_CANDIDATE_EVENT_TYPES)
