import { z } from 'zod'

export const SearchTopicSchema = z.enum(['general', 'news'])
export const SearchDepthSchema = z.enum(['basic', 'advanced'])

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

export const SearchDocumentSchema = z.object({
  title: z.string(),
  url: z.url(),
  content: z.string(),
  publishedAt: SearchPublishedAtSchema.optional(),
  score: z.number().optional(),
})

export const SearchProviderResponseSchema = z.object({
  provider: z.string().min(1),
  requestId: z.string().optional(),
  documents: z.array(SearchDocumentSchema),
})

export type SearchRequest = z.infer<typeof SearchRequestSchema>
export type SearchDocument = z.infer<typeof SearchDocumentSchema>
export type SearchProviderResponse = z.infer<typeof SearchProviderResponseSchema>
