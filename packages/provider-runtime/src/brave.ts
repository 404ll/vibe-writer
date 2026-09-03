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

const BraveResponseSchema = z.object({
  web: z.object({
    results: z.array(z.object({
      title: z.string().default(''),
      url: z.string(),
      description: z.string().default(''),
      page_age: z.string().nullish(),
      age: z.string().nullish(),
    })).default([]),
  }).optional(),
})

export type BraveSearchOptions = {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: ProviderFetch
}

export class BraveSearchProvider implements SearchProvider {
  private readonly fetch: ProviderFetch
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly options: BraveSearchOptions) {
    if (!options.apiKey.trim()) throw new Error('Brave apiKey is required')
    this.fetch = options.fetch ?? globalThis.fetch
    this.baseUrl = options.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search'
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async search(input: SearchProviderRequest) {
    const request = requestSignal(input.signal, this.timeoutMs)
    try {
      const url = new URL(this.baseUrl)
      url.searchParams.set('q', input.query)
      url.searchParams.set('count', String(input.maxResults))
      url.searchParams.set('safesearch', 'moderate')
      url.searchParams.set('text_decorations', 'false')
      url.searchParams.set('spellcheck', 'true')
      if (input.startDate && input.endDate) {
        url.searchParams.set('freshness', `${input.startDate}to${input.endDate}`)
      }
      const response = await this.fetch(url, {
        headers: {
          accept: 'application/json',
          'x-subscription-token': this.options.apiKey,
        },
        signal: request.signal,
      })
      const payload = await responseJson(response)
      if (!response.ok) {
        const auth = response.status === 401 || response.status === 403
        const rate = response.status === 429
        throw new SearchProviderError(
          'Search provider request failed.',
          auth ? 'auth' : rate ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'provider_error',
          rate || response.status >= 500,
          { provider: 'brave', requestId: response.headers.get('x-request-id') ?? undefined },
        )
      }
      const parsed = BraveResponseSchema.safeParse(payload)
      if (!parsed.success) {
        throw new SearchProviderError('Search provider returned an invalid response.', 'invalid_response', false, { provider: 'brave' })
      }
      const projected = SearchProviderResponseSchema.safeParse({
        provider: 'brave',
        requestId: response.headers.get('x-request-id') ?? undefined,
        documents: (parsed.data.web?.results ?? []).map((result) => {
          const publishedAt = SearchPublishedAtSchema.safeParse(result.page_age ?? result.age)
          return {
            title: result.title,
            url: result.url,
            content: result.description,
            ...(publishedAt.success ? { publishedAt: publishedAt.data } : {}),
          }
        }),
      })
      if (!projected.success) {
        throw new SearchProviderError('Search provider returned invalid documents.', 'invalid_response', false, { provider: 'brave' })
      }
      return projected.data
    } catch (error) {
      if (error instanceof SearchProviderError) throw error
      if (input.signal?.aborted) throw new SearchProviderError('Search request was cancelled.', 'cancelled', false, { cause: error, provider: 'brave' })
      if (request.timedOut()) throw new SearchProviderError('Search request timed out.', 'timeout', true, { cause: error, provider: 'brave' })
      throw new SearchProviderError('Search provider is unavailable.', 'unavailable', true, { cause: error, provider: 'brave' })
    } finally {
      request.dispose()
    }
  }
}
