export type ModelFinishReason =
  | 'stop'
  | 'length'
  | 'tool_use'
  | 'content_filter'
  | 'unknown'

export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

export type ModelCallMetadata = Record<string, string | number | boolean>

export type TextModelRequest = {
  operation: string
  promptVersion: string
  system: string
  user: string
  maxTokens: number
  signal?: AbortSignal
  metadata?: ModelCallMetadata
}

export type TextModelResponse = {
  text: string
  provider: string
  model: string
  finishReason: ModelFinishReason
  usage?: ModelUsage
  requestId?: string
  responseId?: string
}

export interface TextModel {
  generate(request: TextModelRequest): Promise<TextModelResponse>
}

export const MODEL_RUNTIME_ERROR_CODES = [
  'authentication',
  'rate_limit',
  'timeout',
  'cancelled',
  'provider_unavailable',
  'invalid_response',
  'unknown',
] as const

export type ModelRuntimeErrorCode = (typeof MODEL_RUNTIME_ERROR_CODES)[number]

export class ModelRuntimeError extends Error {
  readonly code: ModelRuntimeErrorCode
  readonly retryable: boolean
  readonly provider?: string

  constructor(
    message: string,
    options: {
      code: ModelRuntimeErrorCode
      retryable: boolean
      provider?: string
      cause?: unknown
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'ModelRuntimeError'
    this.code = options.code
    this.retryable = options.retryable
    this.provider = options.provider
  }
}
