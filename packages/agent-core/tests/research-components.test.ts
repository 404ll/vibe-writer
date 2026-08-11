import { readFileSync } from 'node:fs'
import { ResearchComponentFixtureSchema } from '@vibe-writer/contracts/research-component-fixtures'
import type {
  SearchDocument,
  SearchProviderResponse,
} from '@vibe-writer/contracts/research'
import type {
  TextModel,
  TextModelRequest,
  TextModelResponse,
} from '@vibe-writer/model-runtime'
import { ModelRuntimeError } from '@vibe-writer/model-runtime'
import { describe, expect, it } from 'vitest'
import { CoveragePlannerService, parseCoveragePlan } from '../src/coverage'
import {
  buildSearchRequest,
  rankSearchDocuments,
  ResearchService,
  SearchProviderError,
  type SearchProvider,
  type SearchProviderRequest,
} from '../src/research'
import { PROMPT_VERSIONS } from '../src/versions'

const fixture = ResearchComponentFixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../contracts/fixtures/opinion-search-baseline.json', import.meta.url),
      'utf8',
    ),
  ),
)

class ScriptedTextModel implements TextModel {
  readonly requests: TextModelRequest[] = []

  constructor(private readonly responses: Array<string | Error>) {}

  async generate(request: TextModelRequest): Promise<TextModelResponse> {
    this.requests.push(request)
    const text = this.responses.shift()
    if (text === undefined) throw new Error(`No scripted response for ${request.operation}`)
    if (text instanceof Error) throw text
    return {
      text,
      provider: 'scripted-model-provider',
      model: 'fixture-model',
      finishReason: 'stop',
    }
  }
}

class ScriptedSearchProvider implements SearchProvider {
  readonly requests: SearchProviderRequest[] = []

  constructor(
    private readonly response: SearchProviderResponse | Error,
  ) {}

  async search(request: SearchProviderRequest): Promise<SearchProviderResponse> {
    this.requests.push(request)
    if (this.response instanceof Error) throw this.response
    return this.response
  }
}

function document(input: Partial<SearchDocument> & Pick<SearchDocument, 'url'>): SearchDocument {
  return {
    title: '来源标题',
    content: '来源摘要',
    ...input,
  }
}

describe('CoveragePlannerService target behavior', () => {
  it.each(fixture.coverage_output_cases)('maps $id to the target status', (testCase) => {
    const result = parseCoveragePlan(testCase.raw)
    expect(result.status).toBe(testCase.target_status)
    expect(result.points).toEqual(
      testCase.target_points.map((point) => ({
        text: point.text,
        searchQuery: point.search_query,
      })),
    )
  })

  it('uses a versioned model operation and returns paired coverage points', async () => {
    const model = new ScriptedTextModel([fixture.coverage_output_cases[0]?.raw ?? ''])
    const service = new CoveragePlannerService(model)
    const controller = new AbortController()

    const result = await service.plan({
      topic: 'Agent 工程',
      outline: '1. 执行循环',
      chapterTitle: '执行循环',
      signal: controller.signal,
    })

    expect(result.status).toBe('ready')
    expect(model.requests[0]).toMatchObject({
      operation: 'coverage-planner.plan',
      promptVersion: PROMPT_VERSIONS.coveragePlanner,
      maxTokens: 1024,
      signal: controller.signal,
    })
    expect(model.requests[0]?.user).toContain('当前章节：执行循环')
  })
})

describe('search policy and ranking target behavior', () => {
  it.each(fixture.search_policy_cases)('builds deterministic policy for $id', (testCase) => {
    expect(buildSearchRequest(testCase.query, new Date(`${fixture.as_of_date}T00:00:00Z`))).toEqual({
      query: testCase.query,
      topic: testCase.target.topic,
      maxResults: testCase.target.max_results,
      searchDepth: testCase.target.search_depth,
      startDate: testCase.target.start_date,
      endDate: testCase.target.end_date,
    })
  })

  it('rejects a blank search query before calling a provider', () => {
    expect(() => buildSearchRequest('   ', new Date('2026-08-07T00:00:00Z'))).toThrow()
  })

  it.each(fixture.search_ranking_cases)('ranks $id with explicit undated policy', (testCase) => {
    const documents = testCase.documents.map((item) =>
      document({
        title: item.id,
        url: `https://example.com/${item.id}`,
        publishedAt: item.published_at ?? undefined,
      }),
    )

    expect(rankSearchDocuments(documents).map((item) => item.title)).toEqual(
      testCase.target_order,
    )
  })

  it('filters sources published after the reproducible as-of boundary', () => {
    const documents = [
      document({
        title: '未来来源',
        url: 'https://example.com/future',
        publishedAt: '2027-01-01',
      }),
      document({
        title: '边界内来源',
        url: 'https://example.com/current',
        publishedAt: '2026-08-07T23:00:00Z',
      }),
    ]

    expect(rankSearchDocuments(documents, fixture.as_of_date).map((item) => item.title)).toEqual([
      '边界内来源',
    ])
  })
})

describe('ResearchService', () => {
  it('keeps sources, forwards cancellation, and distills with a reproducible date', async () => {
    const provider = new ScriptedSearchProvider({
      provider: 'scripted-search',
      requestId: 'search-request-1',
      documents: [
        document({
          title: '无日期来源',
          url: 'https://example.com/undated',
          score: 0.99,
        }),
        document({
          title: '旧来源',
          url: 'https://example.com/old',
          publishedAt: '2025-01-01',
        }),
        document({
          title: '新来源',
          url: 'https://example.com/new',
          publishedAt: '2026-08-01',
        }),
        document({
          title: '第四条会被裁剪',
          url: 'https://example.com/fourth',
        }),
      ],
    })
    const model = new ScriptedTextModel(['- [1] 近期事实'])
    const controller = new AbortController()
    const service = new ResearchService(
      provider,
      model,
      () => new Date(`${fixture.as_of_date}T12:00:00Z`),
    )

    const result = await service.research({ query: '2026 最新 AI 政策', signal: controller.signal })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('Expected ready research result')
    expect(result.sources).toEqual([
      {
        title: '新来源',
        url: 'https://example.com/new',
        content: '来源摘要',
        publishedAt: '2026-08-01',
      },
      {
        title: '旧来源',
        url: 'https://example.com/old',
        content: '来源摘要',
        publishedAt: '2025-01-01',
      },
      {
        title: '无日期来源',
        url: 'https://example.com/undated',
        content: '来源摘要',
        score: 0.99,
      },
    ])
    expect(result.requestId).toBe('search-request-1')
    expect(provider.requests[0]).toMatchObject({
      topic: 'news',
      startDate: '2026-05-09',
      endDate: '2026-08-07',
      signal: controller.signal,
    })
    expect(model.requests[0]).toMatchObject({
      operation: 'research.distill',
      promptVersion: PROMPT_VERSIONS.research,
      signal: controller.signal,
      metadata: {
        sourceCount: 3,
        searchProvider: 'scripted-search',
        searchRequestId: 'search-request-1',
      },
    })
    expect(model.requests[0]?.system).toContain(`当前日期：${fixture.as_of_date}`)
    expect(model.requests[0]?.user).toContain('[1] 新来源')
    expect(model.requests[0]?.user).toContain('URL: https://example.com/new')
    expect(model.requests[0]?.user).toContain('发布时间: 2026-08-01')
    expect(model.requests[0]?.user).toContain('来源摘要')
  })

  it('returns empty without calling the model when the provider has no documents', async () => {
    const provider = new ScriptedSearchProvider({ provider: 'scripted-search', documents: [] })
    const model = new ScriptedTextModel([])
    const service = new ResearchService(provider, model, () => new Date('2026-08-07T00:00:00Z'))

    await expect(service.research({ query: '普通查询' })).resolves.toMatchObject({
      status: 'empty',
      sources: [],
      provider: 'scripted-search',
    })
    expect(model.requests).toHaveLength(0)
  })

  it('distinguishes unavailable providers from retryable failures', async () => {
    const timeoutController = new AbortController()
    timeoutController.abort()
    const unavailable = new ResearchService(
      new ScriptedSearchProvider(
        new SearchProviderError('missing configuration', 'unavailable', false),
      ),
      new ScriptedTextModel([]),
      () => new Date('2026-08-07T00:00:00Z'),
    )
    const timeout = new ResearchService(
      new ScriptedSearchProvider(new SearchProviderError('timed out', 'timeout', true)),
      new ScriptedTextModel([]),
      () => new Date('2026-08-07T00:00:00Z'),
    )

    await expect(unavailable.research({ query: '查询' })).resolves.toMatchObject({
      status: 'unavailable',
      stage: 'search',
      reason: 'unavailable',
      retryable: false,
    })
    await expect(
      timeout.research({ query: '查询', signal: timeoutController.signal }),
    ).resolves.toMatchObject({
      status: 'failed',
      stage: 'search',
      reason: 'timeout',
      retryable: true,
    })
  })

  it('propagates provider cancellation instead of converting it to a failed result', async () => {
    const controller = new AbortController()
    controller.abort()
    const service = new ResearchService(
      new ScriptedSearchProvider(new DOMException('cancelled', 'AbortError')),
      new ScriptedTextModel([]),
      () => new Date('2026-08-07T00:00:00Z'),
    )

    await expect(
      service.research({ query: '查询', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('maps model runtime failures while preserving search provenance', async () => {
    const provider = new ScriptedSearchProvider({
      provider: 'scripted-search',
      requestId: 'search-request-2',
      documents: [document({ url: 'https://example.com/source' })],
    })
    const modelError = new ModelRuntimeError('model timed out', {
      code: 'timeout',
      retryable: true,
      provider: 'scripted-model-provider',
    })
    const service = new ResearchService(
      provider,
      new ScriptedTextModel([modelError]),
      () => new Date('2026-08-07T00:00:00Z'),
    )

    const result = await service.research({ query: '查询' })
    expect(result).toMatchObject({
      status: 'failed',
      stage: 'distillation',
      reason: 'model_error',
      modelErrorCode: 'timeout',
      retryable: true,
      provider: 'scripted-search',
      requestId: 'search-request-2',
    })
    expect(result.sources).toHaveLength(1)
  })

  it('propagates model cancellation to the task lifecycle', async () => {
    const provider = new ScriptedSearchProvider({
      provider: 'scripted-search',
      documents: [document({ url: 'https://example.com/source' })],
    })
    const cancellation = new ModelRuntimeError('cancelled', {
      code: 'cancelled',
      retryable: false,
    })
    const service = new ResearchService(
      provider,
      new ScriptedTextModel([cancellation]),
      () => new Date('2026-08-07T00:00:00Z'),
    )

    await expect(service.research({ query: '查询' })).rejects.toBe(cancellation)
  })

  it('retains gathered sources when distillation returns an empty response', async () => {
    const provider = new ScriptedSearchProvider({
      provider: 'scripted-search',
      documents: [document({ url: 'https://example.com/source' })],
    })
    const service = new ResearchService(
      provider,
      new ScriptedTextModel(['   ']),
      () => new Date('2026-08-07T00:00:00Z'),
    )

    const result = await service.research({ query: '查询' })
    expect(result).toMatchObject({
      status: 'failed',
      stage: 'distillation',
      reason: 'empty_model_output',
      retryable: true,
      provider: 'scripted-search',
    })
    expect(result.sources).toHaveLength(1)
  })
})
