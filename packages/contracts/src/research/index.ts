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
