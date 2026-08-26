/**
 * 检索编排：查询策略 → SearchProvider → 排序 → 模型蒸馏。
 *
 * Agent 只认识供应商无关的文档形状和结构化 status。供应商 SDK、鉴权、超时与
 * 中文错误文案必须停在 Worker adapter。Writer 只能消费 ready/empty/unavailable/failed，
 * 不能把 SDK response 当证据。`clock` 可注入，保证评测能以固定 as-of 日期重放。
 */
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

/** 可注入时钟；默认墙钟。评测必须传入固定 as-of，否则日期窗会随运行时刻漂移。 */
export type Clock = () => Date

export type SearchProviderRequest = SearchRequest & {
  signal?: AbortSignal
  effectScope?: string
}

/** 领域搜索端口。实现放在 provider-runtime；本包禁止 import Tavily/其他 SDK。 */
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

/** 给 Writer 的结构化结果；ready 才含可引用摘要，unavailable/failed 不得当证据。 */
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

/** 查询里出现历史年份且没有「最新」类词时，把窗口钉在那些年份，避免把旧事件搜成新闻。 */
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

/** 新闻类查询走更短 recency 窗口；历史年份查询优先，避免「2020 政策」被当成今日新闻。 */
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

/** 把自然语言查询变成可重放的 SearchRequest：日期上下界来自 clock，而不是供应商默认值。 */
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

/** 先丢掉 as-of 之后的文档，再按日期、分数、原始顺序排序；截取在调用方完成。 */
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

/** 鉴权失败视为 unavailable（可换供应商），其它搜索异常视为 failed。 */
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

  /** 搜索失败不抛给 Writer；取消除外。蒸馏空白视为 failed 且可重试。 */
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
      // 取消必须向上抛，让 Graph/Worker 中止整次 attempt；其它搜索失败收敛为结构化 status。
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
      // 搜索已成功时仍保留 sources，方便审计；失败不得把空摘要伪装成 ready。
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
