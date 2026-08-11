import {
  buildMemoryExtractorPrompt,
  parseMemoryExtractorResponse,
  type MemoryExtractionPromptInput,
} from '@vibe-writer/memory-core'
import {
  ModelRuntimeError,
  type TextModel,
} from '@vibe-writer/model-runtime'
import {
  MemoryExtractionProviderError,
  type MemoryExtractor,
} from './memory-extraction'

export type VersionedPromptMemoryExtractorOptions = {
  maxTokens: number
}

export function completedArticlePromptSource(input: {
  topic: string
  content: string
}): MemoryExtractionPromptInput {
  return {
    segments: [
      {
        id: 'job-topic',
        author: 'user',
        scope: 'task',
        text: input.topic,
      },
      {
        id: 'generated-article',
        author: 'assistant',
        scope: 'task',
        text: input.content,
      },
    ],
  }
}

function providerError(error: unknown): MemoryExtractionProviderError {
  if (error instanceof MemoryExtractionProviderError) return error
  if (error instanceof ModelRuntimeError) {
    const knownFailed = error.code === 'authentication' || error.code === 'rate_limit'
    return new MemoryExtractionProviderError(
      error.code,
      `Memory extraction model failed: ${error.code}`,
      {
        outcome: knownFailed ? 'failed' : 'uncertain',
        retryable: knownFailed && error.retryable,
      },
    )
  }
  return new MemoryExtractionProviderError(
    'provider_outcome_unknown',
    'Memory extraction model outcome is unknown.',
    { outcome: 'uncertain', retryable: false },
  )
}

export class VersionedPromptMemoryExtractor implements MemoryExtractor {
  readonly maxOutputTokens: number

  constructor(
    private readonly model: TextModel,
    private readonly options: VersionedPromptMemoryExtractorOptions,
  ) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 4_096) {
      throw new Error('Memory extractor maxTokens must be an integer between 1 and 4096')
    }
    this.maxOutputTokens = options.maxTokens
  }

  async extract(input: {
    promptInput: MemoryExtractionPromptInput
    signal?: AbortSignal
  }) {
    const prompt = buildMemoryExtractorPrompt(input.promptInput)
    let response
    try {
      response = await this.model.generate({
        operation: 'memory.extract',
        promptVersion: prompt.promptVersion,
        system: prompt.system,
        user: prompt.user,
        maxTokens: this.options.maxTokens,
        ...(input.signal ? { signal: input.signal } : {}),
        metadata: {
          sourceContract: 'trusted-segments-v1',
          outputSchemaVersion: 1,
        },
      })
    } catch (error) {
      throw providerError(error)
    }
    let output
    try {
      output = parseMemoryExtractorResponse(response.text)
    } catch {
      throw new MemoryExtractionProviderError(
        'invalid_response',
        'Memory extraction model returned an invalid structured response.',
        { outcome: 'uncertain', retryable: false },
      )
    }
    return {
      output,
      provider: response.provider,
      model: response.model,
      ...(response.requestId ? { requestId: response.requestId } : {}),
      ...(response.responseId ? { responseId: response.responseId } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    }
  }
}
