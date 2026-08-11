import type { JsonObject } from '@vibe-writer/model-runtime'
import {
  ModelRuntimeError,
  type ModelFinishReason,
  type TextModel,
  type TextModelRequest,
  type TextModelResponse,
  type ToolAssistantBlock,
  type ToolModel,
  type ToolModelRequest,
  type ToolModelResponse,
} from '@vibe-writer/model-runtime'
import { z } from 'zod'
import { requestSignal, responseJson, type ProviderFetch } from './http'

const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
])

const MessageResponseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  content: z.array(ContentBlockSchema),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
})

export type AnthropicModelOptions = {
  apiKey: string
  model: string
  baseUrl?: string
  timeoutMs?: number
  anthropicVersion?: string
  fetch?: ProviderFetch
}

function textFinishReason(reason: string | null): ModelFinishReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'refusal') return 'content_filter'
  return 'unknown'
}

function toolFinishReason(reason: string | null): ToolModelResponse['stopReason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end_turn'
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens') return 'max_tokens'
  if (reason === 'refusal') return 'refusal'
  if (reason === 'pause_turn') return 'pause_turn'
  return 'unknown'
}

function errorForStatus(status: number): ModelRuntimeError {
  if (status === 401 || status === 403) {
    return new ModelRuntimeError('Model provider authentication failed.', {
      code: 'authentication', retryable: false, provider: 'anthropic',
    })
  }
  if (status === 429) {
    return new ModelRuntimeError('Model provider rate limit exceeded.', {
      code: 'rate_limit', retryable: true, provider: 'anthropic',
    })
  }
  return new ModelRuntimeError('Model provider request failed.', {
    code: status >= 500 ? 'provider_unavailable' : 'unknown',
    retryable: status >= 500,
    provider: 'anthropic',
  })
}

export class AnthropicModel implements TextModel, ToolModel {
  private readonly fetch: ProviderFetch
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly options: AnthropicModelOptions) {
    if (!options.apiKey.trim()) throw new Error('Anthropic apiKey is required')
    if (!options.model.trim()) throw new Error('Anthropic model is required')
    this.fetch = options.fetch ?? globalThis.fetch
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/u, '')
    this.timeoutMs = options.timeoutMs ?? 120_000
  }

  async generate(request: TextModelRequest): Promise<TextModelResponse> {
    const result = await this.messages({
      model: this.options.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    }, request.signal)
    const response = result.message
    const textBlocks = response.content.filter((block) => block.type === 'text')
    const thinkingBlocks = response.content.filter((block) => block.type === 'thinking')
    const text = (textBlocks.length ? textBlocks : thinkingBlocks)
      .map((block) => block.type === 'text' ? block.text : block.thinking)
      .join('')
    return {
      text,
      provider: 'anthropic',
      model: response.model,
      finishReason: textFinishReason(response.stop_reason),
      responseId: response.id,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(response.usage ? { usage: this.usage(response.usage) } : {}),
    }
  }

  async generateWithTools(request: ToolModelRequest): Promise<ToolModelResponse> {
    const result = await this.messages({
      model: this.options.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content.map((block) => {
          if (block.type === 'text') return block
          if (block.type === 'tool_call') {
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
          }
          return {
            type: 'tool_result',
            tool_use_id: block.toolCallId,
            content: block.content,
            is_error: block.isError,
          }
        }),
      })),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    }, request.signal)
    const response = result.message
    const blocks = response.content.flatMap<ToolAssistantBlock>((block) => {
      if (block.type === 'text') return [{ type: 'text', text: block.text }]
      if (block.type === 'tool_use') {
        return [{ type: 'tool_call', id: block.id, name: block.name, input: block.input as JsonObject }]
      }
      return []
    })
    return {
      blocks,
      stopReason: toolFinishReason(response.stop_reason),
      provider: 'anthropic',
      model: response.model,
      responseId: response.id,
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(response.usage ? { usage: this.usage(response.usage) } : {}),
    }
  }

  private usage(usage: z.infer<typeof MessageResponseSchema>['usage'] & {}) {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens !== undefined
        ? { cacheReadInputTokens: usage.cache_read_input_tokens }
        : {}),
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cacheWriteInputTokens: usage.cache_creation_input_tokens }
        : {}),
    }
  }

  private async messages(body: Record<string, unknown>, caller?: AbortSignal) {
    const request = requestSignal(caller, this.timeoutMs)
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': this.options.anthropicVersion ?? '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      })
      const payload = await responseJson(response)
      if (!response.ok) throw errorForStatus(response.status)
      const parsed = MessageResponseSchema.safeParse(payload)
      if (!parsed.success) {
        throw new ModelRuntimeError('Model provider returned an invalid response.', {
          code: 'invalid_response', retryable: false, provider: 'anthropic',
        })
      }
      const requestId = response.headers.get('request-id')?.trim()
      return {
        message: parsed.data,
        ...(requestId ? { requestId } : {}),
      }
    } catch (error) {
      if (error instanceof ModelRuntimeError) throw error
      if (caller?.aborted) {
        throw new ModelRuntimeError('Model request was cancelled.', {
          code: 'cancelled', retryable: false, provider: 'anthropic', cause: error,
        })
      }
      if (request.timedOut()) {
        throw new ModelRuntimeError('Model request timed out.', {
          code: 'timeout', retryable: true, provider: 'anthropic', cause: error,
        })
      }
      throw new ModelRuntimeError('Model provider is unavailable.', {
        code: 'provider_unavailable', retryable: true, provider: 'anthropic', cause: error,
      })
    } finally {
      request.dispose()
    }
  }
}
