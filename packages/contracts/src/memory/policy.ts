import { z } from 'zod'
import { ListMemoryCandidatesResponseSchema } from './management/candidates'
import { ListActiveMemoriesResponseSchema } from './management/records'
import {
  ListMemorySignalsResponseSchema,
  MemoryConsentPolicyVersionSchema,
  MemorySourceSignalKindSchema,
  MemorySubjectSchema,
} from './signals'

/**
 * Memory 策略、权限与管理页面启动数据。
 *
 * 策略文档回答“允许收集什么、保留多久”；workspace role 转换成 capabilities，
 * 页面只根据服务端返回的能力开放操作，不在客户端自行推断权限。
 */

export const MEMORY_WORKSPACE_ROLES = ['viewer', 'editor', 'owner'] as const

const PolicyTextSchema = z.string().trim().min(1).max(1_000)

/** 版本化同意策略；历史信号通过 policy_version 指回创建时生效的文档。 */
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

/** 服务端根据 workspace role 计算出的动作级权限。 */
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

/** 策略接口同时返回策略正文和当前请求主体可执行的操作。 */
export const MemoryPolicyAccessResponseSchema = z.object({
  policy: MemoryConsentPolicyDocumentSchema,
  workspace: z.object({
    role: z.enum(MEMORY_WORKSPACE_ROLES),
    capabilities: MemoryManagementCapabilitiesSchema,
    signal_subjects: z.array(MemorySignalSubjectOptionSchema).max(16),
  }).strict(),
}).strict()

/** 管理页面首屏一次取得权限、活跃记忆、来源信号和待审候选。 */
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
