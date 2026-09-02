import { z } from 'zod'

/**
 * 供应商无关的检索契约。
 *
 * Agent/Workflow 只依赖这里的请求和文档形状；Tavily 等 Provider Adapter 负责把
 * 供应商参数与响应转换成这个统一协议，避免供应商字段渗入 Agent Core。
 */

/** topic 决定内容时效类型，depth 决定供应商侧的检索成本和覆盖范围。 */
export const SearchTopicSchema = z.enum(['general', 'news'])
export const SearchDepthSchema = z.enum(['basic', 'advanced'])

/** Agent 发给 Search Port 的标准请求；日期边界只有调用方明确需要时才出现。 */
export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1),
  topic: SearchTopicSchema,
  searchDepth: SearchDepthSchema,
  maxResults: z.number().int().min(1).max(20),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
})

export const SearchPublishedAtSchema = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true }),
])

/** 不同搜索供应商返回的结果统一归一化成该文档结构。 */
export const SearchDocumentSchema = z.object({
  title: z.string(),
  url: z.url(),
  content: z.string(),
  publishedAt: SearchPublishedAtSchema.optional(),
  score: z.number().optional(),
})

/** Provider 名称和 requestId 用于追踪，documents 才是 Agent 消费的业务数据。 */
export const SearchProviderResponseSchema = z.object({
  provider: z.string().min(1),
  requestId: z.string().optional(),
  documents: z.array(SearchDocumentSchema),
})

export type SearchRequest = z.infer<typeof SearchRequestSchema>
export type SearchDocument = z.infer<typeof SearchDocumentSchema>
export type SearchProviderResponse = z.infer<typeof SearchProviderResponseSchema>

/** 模型选择 URL 后交给本地 extractor 的最小请求；只允许公开 HTTP(S) 页面。 */
export const WebExtractRequestSchema = z.object({
  url: z.url().max(2_048),
})

/** 网页正文提取结果。正文只进入当前工具上下文，不进入进度事件。 */
export const WebExtractProviderResponseSchema = z.object({
  provider: z.string().min(1),
  url: z.url().max(2_048),
  finalUrl: z.url().max(2_048),
  title: z.string().max(500).optional(),
  contentType: z.string().min(1).max(100),
  content: z.string().max(100_000),
  truncated: z.boolean(),
})

export type WebExtractRequest = z.infer<typeof WebExtractRequestSchema>
export type WebExtractProviderResponse = z.infer<typeof WebExtractProviderResponseSchema>
