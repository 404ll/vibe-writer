import { z } from 'zod'

/**
 * 用户显式提交的 Memory 来源信号。
 *
 * 信号是“用户说过什么”的可审计证据，不等于已经生效的长期记忆。Route Handler
 * 先持久化信号，后续提取与策略流程再把它转换成候选，并经过审核后成为 ActiveMemory。
 */

/** 区分主动要求记住、偏好设置和纠错，供提取与删除策略判断来源语义。 */
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

/** 重试相同创建请求时复用结果，避免网络重放生成重复信号。 */
export const MemorySignalIdempotencyKeySchema = z.string().trim().min(1).max(256)

/** 同意记录绑定具体策略版本，保证以后能解释当时依据的是哪份规则。 */
export const MemoryConsentPolicyVersionSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)

/** Memory 可以归属于 workspace、具体用户或项目，而不是依赖供应商账号标识。 */
export const MemorySubjectSchema = z.object({
  kind: MemorySubjectKindSchema,
  key: z.string().trim().min(1).max(256),
}).strict()

/** 当前产品只接受用户明确授权的信号，不把模型推断当作用户同意。 */
export const ExplicitMemoryConsentSchema = z.object({
  basis: z.literal('explicit_user'),
  policy_version: MemoryConsentPolicyVersionSchema,
}).strict()

export const MemorySignalPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(1_024).optional(),
}).strict()

/** `POST /api/durable/memory/signals` 的请求体。 */
export const CreateMemorySignalRequestSchema = z.object({
  source_kind: MemorySourceSignalKindSchema,
  subject: MemorySubjectSchema,
  text: z.string().trim().min(1).max(20_000),
  consent: ExplicitMemoryConsentSchema,
  retention_days: z.number().int().min(1).max(365),
  source_run_id: z.uuid().optional(),
}).strict()

/** 已持久化的来源证据；retention_until 到期后会进入清理流程。 */
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

/** created=false 表示命中了幂等结果，而不是又创建了一条信号。 */
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

/** replayed=true 表示相同删除命令已经执行过，本次返回既有删除结果。 */
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
