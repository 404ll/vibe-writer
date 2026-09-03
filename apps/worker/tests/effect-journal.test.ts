import type { SearchProvider, WebPageExtractor } from '@vibe-writer/agent-core'
import type {
  FinishRunEffectInput,
  ReserveRunEffectInput,
} from '@vibe-writer/db'
import type {
  TextModel,
  ToolModel,
} from '@vibe-writer/model-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  EffectJournalModel,
  EffectJournalSearchProvider,
  EffectJournalWebPageExtractor,
} from '../src/effect-journal'

const identity = { jobId: 'job-1', runId: 'run-1', leaseToken: 'lease-1' }

function journal(reservation: 'reserved' | 'uncertain' = 'reserved') {
  return {
    reserveRunEffect: vi.fn(async (_input: ReserveRunEffectInput) => ({
      status: reservation,
      effect: {},
    }) as never),
    finishRunEffect: vi.fn(async (_input: FinishRunEffectInput) => ({
      status: 'finished',
      effect: {},
    }) as never),
  }
}

describe('fenced provider effect journal', () => {
  it('reserves before a text call and stores bounded metadata without prompt content', async () => {
    const control = journal()
    const provider: TextModel & ToolModel = {
      generate: vi.fn(async () => ({
        text: 'private response', provider: 'anthropic', model: 'model-1',
        finishReason: 'stop' as const, requestId: 'req-1', responseId: 'msg-1',
        usage: { inputTokens: 10, outputTokens: 2 },
      })),
      generateWithTools: vi.fn(),
    }
    const model = new EffectJournalModel(provider, control, identity)
    await model.generate({
      operation: 'planner.plan', promptVersion: 'p1', system: 'private system',
      user: 'private user', maxTokens: 100, metadata: { effectScope: 'plan:attempt:1' },
    })
    expect(control.reserveRunEffect).toHaveBeenCalledWith(expect.objectContaining({
      ...identity, effectKey: 'model:plan:attempt:1', effectType: 'model_call',
      requestFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }))
    const finish = control.finishRunEffect.mock.calls[0]![0]
    expect(finish).toMatchObject({
      effectKey: 'model:plan:attempt:1', outcome: 'succeeded',
      resultMetadata: {
        provider: 'anthropic', model: 'model-1', requestId: 'req-1', responseId: 'msg-1',
      },
    })
    expect(JSON.stringify(finish)).not.toContain('private')
  })

  it('does not call a provider when reservation is uncertain', async () => {
    const control = journal('uncertain')
    const generate = vi.fn()
    const model = new EffectJournalModel({ generate, generateWithTools: vi.fn() }, control, identity)
    await expect(model.generate({
      operation: 'planner.plan', promptVersion: 'p1', system: 's', user: 'u',
      maxTokens: 10, metadata: { effectScope: 'plan:attempt:1' },
    })).rejects.toMatchObject({ code: 'effect_uncertain' })
    expect(generate).not.toHaveBeenCalled()
  })

  it('records a sanitized provider failure without swallowing the original error', async () => {
    const control = journal()
    const providerError = Object.assign(new Error('private provider payload'), {
      code: 'rate_limit',
    })
    const model = new EffectJournalModel({
      generate: vi.fn(async () => { throw providerError }),
      generateWithTools: vi.fn(),
    }, control, identity)

    await expect(model.generate({
      operation: 'planner.plan', promptVersion: 'p1', system: 'private system',
      user: 'private user', maxTokens: 10,
      metadata: { effectScope: 'plan:attempt:1' },
    })).rejects.toBe(providerError)
    expect(control.finishRunEffect).toHaveBeenCalledWith({
      ...identity,
      effectKey: 'model:plan:attempt:1',
      outcome: 'failed',
      errorCode: 'rate_limit',
      errorMessage: 'Provider request failed: rate_limit',
    })
    expect(JSON.stringify(control.finishRunEffect.mock.calls)).not.toContain('private')
  })

  it('fails once when a successful provider result loses its journal lease', async () => {
    const control = journal()
    control.finishRunEffect.mockResolvedValue({ status: 'lease_lost' } as never)
    const model = new EffectJournalModel({
      generate: vi.fn(async () => ({
        text: 'response', provider: 'scripted', model: 'scripted-v1',
        finishReason: 'stop' as const,
      })),
      generateWithTools: vi.fn(),
    }, control, identity)

    await expect(model.generate({
      operation: 'planner.plan', promptVersion: 'p1', system: 's', user: 'u',
      maxTokens: 10, metadata: { effectScope: 'plan:attempt:1' },
    })).rejects.toMatchObject({ code: 'effect_lease_lost' })
    expect(control.finishRunEffect).toHaveBeenCalledTimes(1)
  })

  it('uses stable per-node ordinals for tool-model requests', async () => {
    const control = journal()
    const provider = {
      generate: vi.fn(),
      generateWithTools: vi.fn(async () => ({
        blocks: [{ type: 'text' as const, text: 'done' }], stopReason: 'end_turn' as const,
        provider: 'anthropic', model: 'model-1',
      })),
    }
    const model = new EffectJournalModel(provider, control, identity)
    const request = {
      operation: 'writer.chapter', promptVersion: 'p1', toolsetVersion: 't1', system: 's',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'u' }] }],
      tools: [], maxTokens: 10, metadata: { effectScope: 'chapter:0:write:attempt:1' },
    }
    await model.generateWithTools(request)
    await model.generateWithTools(request)
    expect(control.reserveRunEffect.mock.calls.map(([input]) => input.effectKey)).toEqual([
      'model:chapter:0:write:attempt:1:request:1',
      'model:chapter:0:write:attempt:1:request:2',
    ])
  })

  it('journals search metadata without snippets or URLs', async () => {
    const control = journal()
    const provider: SearchProvider = {
      search: vi.fn(async () => ({
        provider: 'tavily', requestId: 'search-1',
        documents: [{ title: 'Private', url: 'https://example.com/private', content: 'private snippet' }],
      })),
    }
    const search = new EffectJournalSearchProvider(provider, control, identity)
    await search.search({
      query: 'private query', topic: 'general', searchDepth: 'advanced', maxResults: 5,
      effectScope: 'chapter:0:write:attempt:1:tool:search:round:1:call:0',
    })
    const finish = control.finishRunEffect.mock.calls[0]![0]
    expect(finish.resultMetadata).toMatchObject({
      provider: 'tavily', requestId: 'search-1', documentCount: 1,
    })
    expect(JSON.stringify(finish)).not.toContain('private')
    expect(JSON.stringify(finish)).not.toContain('example.com')
  })

  it('journals web extraction metadata without the URL or page text', async () => {
    const control = journal()
    const provider: WebPageExtractor = {
      extract: vi.fn(async ({ url }) => ({
        provider: 'readability', url, finalUrl: url, title: 'Private title',
        contentType: 'text/html', content: 'private page text', truncated: false,
      })),
    }
    const extract = new EffectJournalWebPageExtractor(provider, control, identity)
    await extract.extract({
      url: 'https://example.com/private',
      effectScope: 'chapter:0:write:attempt:1:tool:extract_webpage:round:2:call:2',
    })
    const finish = control.finishRunEffect.mock.calls[0]![0]
    expect(finish.resultMetadata).toMatchObject({
      provider: 'readability', contentType: 'text/html', contentLength: 17,
      truncated: false,
    })
    expect(JSON.stringify(finish)).not.toContain('private')
    expect(JSON.stringify(finish)).not.toContain('example.com')
  })
})
