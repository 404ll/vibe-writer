import {
  ModelRuntimeError,
  type TextModel,
  type TextModelRequest,
} from '@vibe-writer/model-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  MemoryExtractionProviderError,
  VersionedPromptMemoryExtractor,
  completedArticlePromptSource,
} from '../src'

function response(text: string) {
  return {
    text,
    provider: 'scripted',
    model: 'scripted-memory-v1',
    finishReason: 'stop' as const,
    requestId: 'memory-request-1',
    responseId: 'memory-response-1',
    usage: { inputTokens: 50, outputTokens: 10 },
  }
}

describe('versioned prompt Memory extractor adapter', () => {
  it('labels completed article provenance as task-scoped user topic plus assistant output', async () => {
    const generate = vi.fn(async (_request: TextModelRequest) => response(JSON.stringify({
      schemaVersion: 1,
      candidates: [],
    })))
    const extractor = new VersionedPromptMemoryExtractor({ generate }, {
      maxTokens: 512,
    })
    await expect(extractor.extract({
      promptInput: completedArticlePromptSource({
        topic: 'Write a concise article',
        content: '# Assistant generated article',
      }),
    })).resolves.toEqual({
      output: { schemaVersion: 1, candidates: [] },
      provider: 'scripted',
      model: 'scripted-memory-v1',
      requestId: 'memory-request-1',
      responseId: 'memory-response-1',
      usage: { inputTokens: 50, outputTokens: 10 },
    })
    const request = generate.mock.calls[0]![0]
    expect(request).toMatchObject({
      operation: 'memory.extract',
      promptVersion: '2026-08-07-v1',
      maxTokens: 512,
      metadata: {
        sourceContract: 'trusted-segments-v1',
        outputSchemaVersion: 1,
      },
    })
    expect(JSON.parse(request.user)).toEqual({
      sourceSegments: [
        { id: 'job-topic', author: 'user', scope: 'task', text: 'Write a concise article' },
        {
          id: 'generated-article',
          author: 'assistant',
          scope: 'task',
          text: '# Assistant generated article',
        },
      ],
    })
  })

  it('treats invalid structured output as an uncertain charged effect', async () => {
    const extractor = new VersionedPromptMemoryExtractor({
      generate: vi.fn(async () => response('```json\n{"schemaVersion":1}\n```')),
    }, {
      maxTokens: 512,
    })
    await expect(extractor.extract({
      promptInput: completedArticlePromptSource({ topic: 'topic', content: 'content' }),
    }))
      .rejects.toMatchObject({
        code: 'invalid_response',
        options: { outcome: 'uncertain', retryable: false },
      })
  })

  it('retries only model errors known to have failed before a successful effect', async () => {
    const model: TextModel = {
      generate: vi.fn(async () => {
        throw new ModelRuntimeError('private rate limit response', {
          code: 'rate_limit',
          retryable: true,
          provider: 'scripted',
        })
      }),
    }
    const extractor = new VersionedPromptMemoryExtractor(model, {
      maxTokens: 512,
    })
    await expect(extractor.extract({
      promptInput: completedArticlePromptSource({ topic: 'topic', content: 'content' }),
    }))
      .rejects.toMatchObject({
        code: 'rate_limit',
        options: { outcome: 'failed', retryable: true },
      })
  })

  it('maps timeout and unknown errors to uncertain without leaking provider details', async () => {
    for (const error of [
      new ModelRuntimeError('private timeout payload', {
        code: 'timeout',
        retryable: true,
        provider: 'scripted',
      }),
      new Error('private unknown payload'),
    ]) {
      const extractor = new VersionedPromptMemoryExtractor({
        generate: vi.fn(async () => { throw error }),
      }, {
        maxTokens: 512,
      })
      let caught: unknown
      try {
        await extractor.extract({
          promptInput: completedArticlePromptSource({ topic: 'topic', content: 'content' }),
        })
      } catch (failure) {
        caught = failure
      }
      expect(caught).toBeInstanceOf(MemoryExtractionProviderError)
      expect(caught).toMatchObject({ options: { outcome: 'uncertain', retryable: false } })
      expect(String(caught)).not.toContain('private')
    }
  })
})
