import {
  SearchProviderResponseSchema,
  SearchPublishedAtSchema,
} from '@vibe-writer/contracts/research'
import {
  SearchProviderError,
  type SearchProvider,
  type SearchProviderRequest,
} from '@vibe-writer/agent-core'
import { z } from 'zod'
import { requestSignal, responseJson, type ProviderFetch } from './http'

const SearXngResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().default(''),
    url: z.string(),
    content: z.string().default(''),
    score: z.number().optional(),
    publishedDate: z.string().nullish(),
  })).default([]),
})

export type SearXngSearchOptions = {
  baseUrl: string
  timeoutMs?: number
  fetch?: ProviderFetch
}

export class SearXngSearchProvider implements SearchProvider {
  private readonly fetch: ProviderFetch
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: SearXngSearchOptions) {
    const url = new URL(options.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('SearXNG baseUrl must use http or https')
    }
    this.fetch = options.fetch ?? globalThis.fetch
    this.baseUrl = options.baseUrl.replace(/\/$/u, '')
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async search(input: SearchProviderRequest) {
    const request = requestSignal(input.signal, this.timeoutMs)
    try {
      const url = new URL(`${this.baseUrl}/search`)
      url.searchParams.set('q', input.query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('categories', input.topic === 'news' ? 'news' : 'general')
      url.searchParams.set('safesearch', '1')
      const response = await this.fetch(url, {
        headers: { accept: 'application/json' },
        signal: request.signal,
      })
      const payload = await responseJson(response)
      if (!response.ok) {
        const rate = response.status === 429
        throw new SearchProviderError(
          'Search provider request failed.',
          rate ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'provider_error',
          rate || response.status >= 500,
          { provider: 'searxng' },
        )
      }
      const parsed = SearXngResponseSchema.safeParse(payload)
      if (!parsed.success) {
        throw new SearchProviderError('Search provider returned an invalid response.', 'invalid_response', false, { provider: 'searxng' })
      }
      const projected = SearchProviderResponseSchema.safeParse({
        provider: 'searxng',
        documents: parsed.data.results.slice(0, input.maxResults).map((result) => {
          const publishedAt = SearchPublishedAtSchema.safeParse(result.publishedDate)
          return {
            title: result.title,
            url: result.url,
            content: result.content,
            ...(publishedAt.success ? { publishedAt: publishedAt.data } : {}),
            ...(result.score !== undefined ? { score: result.score } : {}),
          }
        }),
      })
      if (!projected.success) {
        throw new SearchProviderError('Search provider returned invalid documents.', 'invalid_response', false, { provider: 'searxng' })
      }
      return projected.data
    } catch (error) {
      if (error instanceof SearchProviderError) throw error
      if (input.signal?.aborted) throw new SearchProviderError('Search request was cancelled.', 'cancelled', false, { cause: error, provider: 'searxng' })
      if (request.timedOut()) throw new SearchProviderError('Search request timed out.', 'timeout', true, { cause: error, provider: 'searxng' })
      throw new SearchProviderError('Search provider is unavailable.', 'unavailable', true, { cause: error, provider: 'searxng' })
    } finally {
      request.dispose()
    }
  }
}
