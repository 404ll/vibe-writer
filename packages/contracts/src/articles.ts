import { z } from 'zod'

export const ArticleSummarySchema = z.object({
  id: z.string().min(1),
  job_id: z.string().min(1),
  topic: z.string(),
  word_count: z.number().int().nonnegative(),
  created_at: z.string(),
  revision: z.number().int().nonnegative(),
})

export const ArticleDetailSchema = ArticleSummarySchema.extend({
  content: z.string(),
})

export const ArticleVersionSummarySchema = z.object({
  id: z.number().int().nonnegative(),
  saved_at: z.string(),
  word_count: z.number().int().nonnegative(),
  source_revision: z.number().int().nonnegative(),
})

export const ArticleVersionDetailSchema = z.object({
  id: z.number().int().nonnegative(),
  content: z.string(),
  saved_at: z.string(),
  source_revision: z.number().int().nonnegative(),
})

export const ArticlePatchRequestSchema = z.object({
  content: z.string().min(1),
  expected_revision: z.number().int().nonnegative(),
})

export const ArticleRestoreRequestSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
})

export const ArticleMutationResponseSchema = z.object({
  status: z.literal('ok'),
  article: ArticleDetailSchema,
})

export const ArticleListResponseSchema = z.array(ArticleSummarySchema)
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
