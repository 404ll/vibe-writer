import { describe, expect, it, vi } from 'vitest'
import { AnthropicModel } from '../src/anthropic'
import { TavilySearchProvider } from '../src/tavily'

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

describe('Anthropic model adapter', () => {
  it('maps text, usage and request metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      id: 'msg-1', model: 'model-1', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '完成' }],
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 },
    }, 200, { 'request-id': 'req-1' }))
    const model = new AnthropicModel({
      apiKey: 'secret', model: 'model-1', thinkingMode: 'disabled', fetch,
    })
    await expect(model.generate({
      operation: 'test', promptVersion: 'p1', system: 'system', user: 'user', maxTokens: 100,
    })).resolves.toEqual({
      text: '完成', provider: 'anthropic', model: 'model-1', finishReason: 'stop',
      requestId: 'req-1', responseId: 'msg-1',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3 },
    })
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
    expect(body).toMatchObject({
      model: 'model-1',
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'user' }],
    })
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ 'x-api-key': 'secret' })
  })

  it('translates tool definitions and tool_use blocks', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      id: 'msg-tool', model: 'model-1', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { query: 'TS' } }],
    }))
    const model = new AnthropicModel({ apiKey: 'secret', model: 'model-1', fetch })
    const result = await model.generateWithTools({
      operation: 'writer', promptVersion: 'p1', toolsetVersion: 't1', system: 'system',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'write' }] }],
      tools: [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }],
      maxTokens: 100,
    })
    expect(result).toMatchObject({
      stopReason: 'tool_use',
      responseId: 'msg-tool',
      blocks: [{ type: 'tool_call', id: 'call-1', name: 'search', input: { query: 'TS' } }],
    })
    expect(result.requestId).toBeUndefined()
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      tools: [{ name: 'search', input_schema: { type: 'object' } }],
    })
  })

  it('classifies rate limits as retryable', async () => {
    const model = new AnthropicModel({ apiKey: 'secret', model: 'model-1', fetch: vi.fn(async () => jsonResponse({}, 429)) })
    await expect(model.generate({ operation: 'test', promptVersion: 'p1', system: 's', user: 'u', maxTokens: 10 }))
      .rejects.toMatchObject({ code: 'rate_limit', retryable: true, provider: 'anthropic' })
  })
})

describe('Tavily search adapter', () => {
  it('maps shared date-bounded search contracts', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      request_id: 'search-1',
      results: [{ title: 'Source', url: 'https://example.com', content: 'Fact', score: 0.8, published_date: '2026-08-01' }],
    }))
    const provider = new TavilySearchProvider({ apiKey: 'secret', fetch })
    await expect(provider.search({
      query: '最新 TS', topic: 'news', searchDepth: 'advanced', maxResults: 5,
      startDate: '2026-05-01', endDate: '2026-08-07',
    })).resolves.toMatchObject({ provider: 'tavily', requestId: 'search-1', documents: [{ publishedAt: '2026-08-01' }] })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      search_depth: 'advanced', start_date: '2026-05-01', end_date: '2026-08-07',
    })
  })

  it('classifies authentication failures', async () => {
    const provider = new TavilySearchProvider({ apiKey: 'secret', fetch: vi.fn(async () => jsonResponse({}, 401)) })
    await expect(provider.search({ query: 'TS', topic: 'general', searchDepth: 'basic', maxResults: 3 }))
      .rejects.toMatchObject({ code: 'auth', retryable: false, provider: 'tavily' })
  })
})
