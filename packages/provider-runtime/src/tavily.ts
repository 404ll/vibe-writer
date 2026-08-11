import { SearchProviderResponseSchema } from '@vibe-writer/contracts/research'
import {
  SearchProviderError,
  type SearchProvider,
  type SearchProviderRequest,
} from '@vibe-writer/agent-core'
import { z } from 'zod'
import { requestSignal, responseJson, type ProviderFetch } from './http'

const TavilyResponseSchema = z.object({
  request_id: z.string().optional(),
  results: z.array(z.object({
    title: z.string().default(''),
    url: z.string(),
    content: z.string().default(''),
    score: z.number().optional(),
    published_date: z.string().optional(),
  })),
})

export type TavilySearchOptions = {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: ProviderFetch
}

export class TavilySearchProvider implements SearchProvider {
  private readonly fetch: ProviderFetch
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly options: TavilySearchOptions) {
    if (!options.apiKey.trim()) throw new Error('Tavily apiKey is required')
    this.fetch = options.fetch ?? globalThis.fetch
    this.baseUrl = (options.baseUrl ?? 'https://api.tavily.com').replace(/\/$/u, '')
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async search(input: SearchProviderRequest) {
    const request = requestSignal(input.signal, this.timeoutMs)
    try {
      const response = await this.fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          query: input.query,
          topic: input.topic,
          search_depth: input.searchDepth,
          max_results: input.maxResults,
          include_answer: false,
          include_raw_content: false,
          ...(input.startDate ? { start_date: input.startDate } : {}),
          ...(input.endDate ? { end_date: input.endDate } : {}),
        }),
        signal: request.signal,
      })
      const payload = await responseJson(response)
      if (!response.ok) {
        const auth = response.status === 401 || response.status === 403
        const rate = response.status === 429
        throw new SearchProviderError('Search provider request failed.', auth ? 'auth' : rate ? 'rate_limited' : response.status >= 500 ? 'unavailable' : 'provider_error', rate || response.status >= 500, { provider: 'tavily' })
      }
      const parsed = TavilyResponseSchema.safeParse(payload)
      if (!parsed.success) {
        throw new SearchProviderError('Search provider returned an invalid response.', 'invalid_response', false, { provider: 'tavily' })
      }
      const projected = SearchProviderResponseSchema.safeParse({
        provider: 'tavily',
        requestId: parsed.data.request_id,
        documents: parsed.data.results.map((result) => ({
          title: result.title,
          url: result.url,
          content: result.content,
          ...(result.published_date ? { publishedAt: result.published_date } : {}),
          ...(result.score !== undefined ? { score: result.score } : {}),
        })),
      })
      if (!projected.success) {
        throw new SearchProviderError('Search provider returned invalid documents.', 'invalid_response', false, { provider: 'tavily' })
      }
      return projected.data
    } catch (error) {
      if (error instanceof SearchProviderError) throw error
      if (input.signal?.aborted) throw new SearchProviderError('Search request was cancelled.', 'cancelled', false, { cause: error, provider: 'tavily' })
      if (request.timedOut()) throw new SearchProviderError('Search request timed out.', 'timeout', true, { cause: error, provider: 'tavily' })
      throw new SearchProviderError('Search provider is unavailable.', 'unavailable', true, { cause: error, provider: 'tavily' })
    } finally {
      request.dispose()
    }
  }
}
