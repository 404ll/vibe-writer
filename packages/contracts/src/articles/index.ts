import { z } from 'zod'

/**
 * 文章 CRUD 与历史版本契约。
 *
 * Route Handler 用这些 Schema 校验请求和响应，Web API client 再解析一次响应；
 * 因此前后端即使部署节奏不同，也会在协议漂移发生的位置立即失败。
 */

/** 列表页需要的轻量文章信息，不携带可能很大的 Markdown 正文。 */
export const ArticleSummarySchema = z.object({
  id: z.string().min(1),
  job_id: z.string().min(1),
  topic: z.string(),
  word_count: z.number().int().nonnegative(),
  created_at: z.string(),
  revision: z.number().int().nonnegative(),
})

/** 详情页在摘要字段基础上增加完整 Markdown 正文。 */
export const ArticleDetailSchema = ArticleSummarySchema.extend({
  content: z.string(),
})

/** 历史抽屉的版本列表只展示元信息，点击后再加载具体正文。 */
export const ArticleVersionSummarySchema = z.object({
  id: z.number().int().nonnegative(),
  saved_at: z.string(),
  word_count: z.number().int().nonnegative(),
  source_revision: z.number().int().nonnegative(),
})

/** 单个历史版本的预览数据。 */
export const ArticleVersionDetailSchema = z.object({
  id: z.number().int().nonnegative(),
  content: z.string(),
  saved_at: z.string(),
  source_revision: z.number().int().nonnegative(),
})

/**
 * 更新正文时必须携带调用方最后看到的 revision。
 * 服务端只在它仍等于当前 revision 时写入，避免两个编辑页面互相覆盖。
 */
export const ArticlePatchRequestSchema = z.object({
  content: z.string().min(1),
  expected_revision: z.number().int().nonnegative(),
})

/** 恢复历史版本同样是一次写操作，因此也要执行 revision 并发检查。 */
export const ArticleRestoreRequestSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
})

/** 更新或恢复成功后返回最新文章，让页面同步 content、word_count 和 revision。 */
export const ArticleMutationResponseSchema = z.object({
  status: z.literal('ok'),
  article: ArticleDetailSchema,
})

/** `GET /api/durable/articles` 的响应。 */
export const ArticleListResponseSchema = z.array(ArticleSummarySchema)

/** `GET /api/durable/articles/:articleId/versions` 的响应。 */
export const ArticleVersionsResponseSchema = z.object({
  versions: z.array(ArticleVersionSummarySchema),
})

export type ArticleSummary = z.infer<typeof ArticleSummarySchema>
export type ArticleDetail = z.infer<typeof ArticleDetailSchema>
export type ArticleVersionSummary = z.infer<typeof ArticleVersionSummarySchema>
export type ArticleVersionDetail = z.infer<typeof ArticleVersionDetailSchema>
export type ArticlePatchRequest = z.infer<typeof ArticlePatchRequestSchema>
export type ArticleRestoreRequest = z.infer<typeof ArticleRestoreRequestSchema>
export type ArticleMutationResponse = z.infer<typeof ArticleMutationResponseSchema>
export type ArticleVersionsResponse = z.infer<typeof ArticleVersionsResponseSchema>
