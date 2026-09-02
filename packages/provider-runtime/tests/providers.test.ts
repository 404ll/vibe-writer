import { describe, expect, it, vi } from 'vitest'
import { AnthropicModel } from '../src/anthropic'
import { TavilySearchProvider } from '../src/tavily'
import { BraveSearchProvider } from '../src/brave'
import { SafeReadabilityWebExtractor } from '../src/safe-web-extract'
import { SearXngSearchProvider } from '../src/searxng'

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

describe('additional search adapters', () => {
  it('normalizes Brave results and sends its subscription token only to Brave', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      web: { results: [{ title: 'Brave result', url: 'https://example.com/brave', description: 'Fact', page_age: '2 hours ago' }] },
    }, 200, { 'x-request-id': 'brave-1' }))
    const provider = new BraveSearchProvider({ apiKey: 'secret', fetch })
    await expect(provider.search({
      query: 'agent research', topic: 'general', searchDepth: 'basic', maxResults: 3,
    })).resolves.toMatchObject({
      provider: 'brave',
      requestId: 'brave-1',
      documents: [{ title: 'Brave result', content: 'Fact' }],
    })
    expect((await provider.search({
      query: 'agent research', topic: 'general', searchDepth: 'basic', maxResults: 3,
    })).documents[0]?.publishedAt).toBeUndefined()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toContain('q=agent+research')
    expect(String(url)).not.toContain('freshness=')
    expect(init?.headers).toMatchObject({ 'x-subscription-token': 'secret' })
  })

  it('maps the shared date window to Brave freshness', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ web: { results: [] } }))
    const provider = new BraveSearchProvider({ apiKey: 'secret', fetch })
    await provider.search({
      query: 'agent research', topic: 'news', searchDepth: 'advanced', maxResults: 3,
      startDate: '2026-06-01', endDate: '2026-09-01',
    })
    expect(String(fetch.mock.calls[0]?.[0])).toContain('freshness=2026-06-01to2026-09-01')
  })

  it('normalizes Brave authentication failures without exposing response bodies', async () => {
    const provider = new BraveSearchProvider({
      apiKey: 'secret',
      fetch: vi.fn(async () => jsonResponse({ detail: 'credential detail' }, 401)),
    })
    await expect(provider.search({
      query: 'agent research', topic: 'general', searchDepth: 'basic', maxResults: 3,
    })).rejects.toMatchObject({ code: 'auth', retryable: false, provider: 'brave' })
  })

  it('normalizes SearXNG JSON results without requiring an API key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      results: [{
        title: 'SearXNG result',
        url: 'https://example.com/searxng',
        content: 'Fact',
        score: 0.7,
        publishedDate: '2026-09-01',
      }],
    }))
    const provider = new SearXngSearchProvider({ baseUrl: 'https://search.example', fetch })
    await expect(provider.search({
      query: 'agent research', topic: 'news', searchDepth: 'advanced', maxResults: 3,
    })).resolves.toMatchObject({
      provider: 'searxng',
      documents: [{ title: 'SearXNG result', score: 0.7, publishedAt: '2026-09-01' }],
    })
    expect(String(fetch.mock.calls[0]![0])).toContain('format=json')
    expect(String(fetch.mock.calls[0]![0])).toContain('categories=news')
  })

  it('ignores nullable or non-ISO provider dates instead of rejecting otherwise valid results', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      results: [{ title: 'Result', url: 'https://example.com/result', content: 'Fact', publishedDate: null }],
    }))
    const provider = new SearXngSearchProvider({ baseUrl: 'https://search.example', fetch })
    const result = await provider.search({
      query: 'agent research', topic: 'general', searchDepth: 'basic', maxResults: 3,
    })
    expect(result.documents).toEqual([{ title: 'Result', url: 'https://example.com/result', content: 'Fact' }])
  })

  it('classifies a SearXNG rate limit as retryable', async () => {
    const provider = new SearXngSearchProvider({
      baseUrl: 'https://search.example',
      fetch: vi.fn(async () => jsonResponse({}, 429)),
    })
    await expect(provider.search({
      query: 'agent research', topic: 'general', searchDepth: 'basic', maxResults: 3,
    })).rejects.toMatchObject({ code: 'rate_limited', retryable: true, provider: 'searxng' })
  })
})

describe('safe local web extraction', () => {
  it.each([
    'http://127.0.0.1/private',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/private',
    'http://[::ffff:7f00:1]/private',
    'file:///etc/passwd',
    'https://user:pass@example.com/private',
    'https://example.com:8443/private',
  ])('rejects unsafe URL %s before making a request', async (url) => {
    const request = vi.fn()
    const extractor = new SafeReadabilityWebExtractor({ request })
    await expect(extractor.extract({ url })).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects a public hostname when any resolved address is private', async () => {
    const request = vi.fn()
    const extractor = new SafeReadabilityWebExtractor({
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      request,
    })
    await expect(extractor.extract({ url: 'https://example.com' }))
      .rejects.toMatchObject({ code: 'unsafe_url' })
    expect(request).not.toHaveBeenCalled()
  })

  it('revalidates redirects and never follows them into a private network', async () => {
    const request = vi.fn(async () => ({
      status: 302,
      contentType: 'text/html',
      location: 'http://127.0.0.1/admin',
      body: Buffer.alloc(0),
    }))
    const extractor = new SafeReadabilityWebExtractor({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request,
    })
    await expect(extractor.extract({ url: 'https://example.com' }))
      .rejects.toMatchObject({ code: 'unsafe_url' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('extracts readable text locally and applies a strict text limit', async () => {
    const extractor = new SafeReadabilityWebExtractor({
      maxTextChars: 12,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => ({
        status: 200,
        contentType: 'text/html',
        body: Buffer.from('<html><head><title>Source</title></head><body><article><h1>Heading</h1><p>Long verified paragraph.</p></article></body></html>'),
      }),
    })
    await expect(extractor.extract({ url: 'https://example.com/source' })).resolves.toMatchObject({
      provider: 'readability',
      title: 'Source',
      contentType: 'text/html',
      content: expect.any(String),
      truncated: true,
    })
    const result = await extractor.extract({ url: 'https://example.com/source' })
    expect(result.content.length).toBe(12)
  })

  it('rejects unsupported response content before parsing it', async () => {
    const extractor = new SafeReadabilityWebExtractor({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => ({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.7'),
      }),
    })
    await expect(extractor.extract({ url: 'https://example.com/source.pdf' }))
      .rejects.toMatchObject({ code: 'unsupported_content_type' })
  })
})
