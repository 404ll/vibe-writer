import type {
  SearchDocument,
  SearchProviderResponse,
  SearchRequest,
} from '@vibe-writer/contracts/research'
import { SearchRequestSchema } from '@vibe-writer/contracts/research'
import {
  ModelRuntimeError,
  type ModelRuntimeErrorCode,
  type TextModel,
  type TextModelResponse,
} from '@vibe-writer/model-runtime'
import { buildResearchSystemPrompt, buildResearchUserPrompt } from './prompts'
import { PROMPT_VERSIONS } from './versions'

const EXPLICIT_RECENCY_RE = /新闻|最新|近期|今年/i
const NEWS_QUERY_RE =
  /新闻|最新|近期|今年|政策|监管|价格|市场|财报|发布|上线|案例|事故|漏洞|攻击|融资|并购|占比|统计|报告/i
const YEAR_RE = /20\d{2}/g

export type Clock = () => Date

export type SearchProviderRequest = SearchRequest & {
  signal?: AbortSignal
  effectScope?: string
}

export interface SearchProvider {
  search(request: SearchProviderRequest): Promise<SearchProviderResponse>
}

export type SearchProviderErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'invalid_response'
  | 'provider_error'

export class SearchProviderError extends Error {
  readonly name = 'SearchProviderError'

  constructor(
    message: string,
    readonly code: SearchProviderErrorCode,
    readonly retryable: boolean,
    options?: { cause?: unknown; provider?: string; requestId?: string },
  ) {
    super(message, options)
    this.provider = options?.provider
    this.requestId = options?.requestId
  }

  readonly provider?: string
  readonly requestId?: string
}

export type ResearchResult =
  | {
      status: 'ready'
      query: string
      summary: string
      sources: SearchDocument[]
      request: SearchRequest
      provider: string
      requestId?: string
    }
  | {
      status: 'empty'
      query: string
      sources: []
      request: SearchRequest
      provider: string
      requestId?: string
    }
  | {
      status: 'unavailable' | 'failed'
      query: string
      sources: SearchDocument[]
      request: SearchRequest
      stage: 'search' | 'distillation'
      reason: SearchProviderErrorCode | 'empty_model_output' | 'model_error'
      retryable: boolean
      provider?: string
      requestId?: string
      modelErrorCode?: ModelRuntimeErrorCode
    }

function queryYears(query: string): number[] {
  return [...query.matchAll(YEAR_RE)].map((match) => Number(match[0]))
}

function historicalYearRange(query: string, asOf: Date): { startDate: string; endDate: string } | undefined {
  if (EXPLICIT_RECENCY_RE.test(query)) return undefined
  const currentYear = asOf.getUTCFullYear()
  const years = queryYears(query)
  const earliestYear = Math.min(...years)
  if (years.length === 0 || earliestYear >= currentYear) return undefined
  const latestYear = Math.max(...years)
  return {
    startDate: `${earliestYear}-01-01`,
    endDate: latestYear < currentYear ? `${latestYear}-12-31` : isoDate(asOf),
  }
}

export function isNewsLikeQuery(query: string, asOf: Date): boolean {
  if (historicalYearRange(query, asOf)) return false
  const currentYear = asOf.getUTCFullYear()
  return NEWS_QUERY_RE.test(query) || queryYears(query).some((year) => year >= currentYear)
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function daysBefore(date: Date, days: number): Date {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() - days)
  return result
}

export function buildSearchRequest(query: string, asOf: Date): SearchRequest {
  const normalizedQuery = query.trim()
  const historicalRange = historicalYearRange(normalizedQuery, asOf)
  const newsLike = isNewsLikeQuery(normalizedQuery, asOf)
  return SearchRequestSchema.parse({
    query: normalizedQuery,
    topic: newsLike ? 'news' : 'general',
    searchDepth: 'advanced',
    maxResults: 5,
    startDate:
      historicalRange?.startDate ?? isoDate(daysBefore(asOf, newsLike ? 90 : 365)),
    endDate: historicalRange?.endDate ?? isoDate(asOf),
  })
}

function publishedTimestamp(raw?: string): number | undefined {
  if (!raw) return undefined
  const timestamp = Date.parse(raw)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

export function rankSearchDocuments(
  documents: SearchDocument[],
  publishedOnOrBefore?: string,
): SearchDocument[] {
  const upperBound = publishedOnOrBefore
    ? Date.parse(`${publishedOnOrBefore}T23:59:59.999Z`)
    : undefined
  return documents
    .map((document, index) => ({ document, index, timestamp: publishedTimestamp(document.publishedAt) }))
    .filter(({ timestamp }) => upperBound === undefined || timestamp === undefined || timestamp <= upperBound)
    .sort((left, right) => {
      if (left.timestamp !== undefined && right.timestamp === undefined) return -1
      if (left.timestamp === undefined && right.timestamp !== undefined) return 1
      if (left.timestamp !== undefined && right.timestamp !== undefined) {
        const byDate = right.timestamp - left.timestamp
        if (byDate !== 0) return byDate
      }
      const byScore = (right.document.score ?? -1) - (left.document.score ?? -1)
      return byScore !== 0 ? byScore : left.index - right.index
    })
    .map(({ document }) => document)
}

export function formatResearchSources(documents: SearchDocument[]): string {
  return documents
    .map((document, index) => {
      const publishedAt = document.publishedAt ?? '日期未知'
      const title = document.title || '标题未知'
      return `[${index + 1}] ${title}\nURL: ${document.url}\n发布时间: ${publishedAt}\n${document.content}`
    })
    .join('\n\n')
}

function failedResult(
  query: string,
  request: SearchRequest,
  error: unknown,
): Extract<ResearchResult, { status: 'unavailable' | 'failed' }> {
  if (error instanceof SearchProviderError) {
    return {
      status: error.code === 'unavailable' || error.code === 'auth' ? 'unavailable' : 'failed',
      query,
      sources: [],
      request,
      stage: 'search',
      reason: error.code,
      retryable: error.retryable,
      provider: error.provider,
      requestId: error.requestId,
    }
  }
  return {
    status: 'failed',
    query,
    sources: [],
    request,
    stage: 'search',
    reason: 'provider_error',
    retryable: false,
  }
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof SearchProviderError) return error.code === 'cancelled'
  if (error instanceof ModelRuntimeError) return error.code === 'cancelled'
  if (error instanceof Error && error.name === 'AbortError') return true
  return signal?.aborted ?? false
}

export class ResearchService {
  constructor(
    private readonly provider: SearchProvider,
    private readonly model: TextModel,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async research(input: {
    query: string
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ResearchResult> {
    const asOf = this.clock()
    const request = buildSearchRequest(input.query, asOf)
    let providerResponse: SearchProviderResponse
    try {
      providerResponse = await this.provider.search({
        ...request,
        signal: input.signal,
        effectScope: input.effectScope,
      })
    } catch (error) {
      if (isCancellation(error, input.signal)) throw error
      return failedResult(request.query, request, error)
    }

    const sources = rankSearchDocuments(providerResponse.documents, request.endDate).slice(0, 3)
    if (sources.length === 0) {
      return {
        status: 'empty',
        query: request.query,
        sources: [],
        request,
        provider: providerResponse.provider,
        requestId: providerResponse.requestId,
      }
    }

    const metadata = {
      sourceCount: sources.length,
      searchProvider: providerResponse.provider,
      ...(providerResponse.requestId ? { searchRequestId: providerResponse.requestId } : {}),
    }
    let response: TextModelResponse
    try {
      response = await this.model.generate({
        operation: 'research.distill',
        promptVersion: PROMPT_VERSIONS.research,
        system: buildResearchSystemPrompt(isoDate(asOf)),
        user: buildResearchUserPrompt({
          query: request.query,
          snippets: formatResearchSources(sources),
        }),
        maxTokens: 1024,
        signal: input.signal,
        metadata: {
          ...metadata,
          ...(input.effectScope ? { effectScope: `${input.effectScope}:distill` } : {}),
        },
      })
    } catch (error) {
      if (isCancellation(error, input.signal)) throw error
      const modelErrorCode = error instanceof ModelRuntimeError ? error.code : 'unknown'
      return {
        status: 'failed',
        query: request.query,
        sources,
        request,
        stage: 'distillation',
        reason: 'model_error',
        retryable: error instanceof ModelRuntimeError ? error.retryable : false,
        provider: providerResponse.provider,
        requestId: providerResponse.requestId,
        modelErrorCode,
      }
    }

    const summary = response.text.trim()
    if (!summary) {
      return {
        status: 'failed',
        query: request.query,
        sources,
        request,
        stage: 'distillation',
        reason: 'empty_model_output',
        retryable: true,
        provider: providerResponse.provider,
        requestId: providerResponse.requestId,
      }
    }

    return {
      status: 'ready',
      query: request.query,
      summary,
      sources,
      request,
      provider: providerResponse.provider,
      requestId: providerResponse.requestId,
    }
  }
}
