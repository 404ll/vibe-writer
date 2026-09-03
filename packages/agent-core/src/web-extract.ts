import type {
  WebExtractProviderResponse,
  WebExtractRequest,
} from '@vibe-writer/contracts/research'
import { WebExtractRequestSchema } from '@vibe-writer/contracts/research'

export type WebExtractProviderRequest = WebExtractRequest & {
  signal?: AbortSignal
  effectScope?: string
}

/** 领域网页提取端口。网络与 HTML 解析实现必须留在 provider-runtime。 */
export interface WebPageExtractor {
  extract(request: WebExtractProviderRequest): Promise<WebExtractProviderResponse>
}

export type WebExtractErrorCode =
  | 'unsafe_url'
  | 'unsupported_content_type'
  | 'response_too_large'
  | 'empty_content'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'invalid_response'
  | 'provider_error'

export class WebExtractProviderError extends Error {
  readonly name = 'WebExtractProviderError'

  constructor(
    message: string,
    readonly code: WebExtractErrorCode,
    readonly retryable: boolean,
    options?: { cause?: unknown; provider?: string },
  ) {
    super(message, options)
    this.provider = options?.provider
  }

  readonly provider?: string
}

export type WebExtractResult =
  | ({ status: 'ready' } & WebExtractProviderResponse)
  | {
      status: 'unavailable' | 'failed'
      url: string
      reason: WebExtractErrorCode
      retryable: boolean
      provider?: string
    }

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof WebExtractProviderError) return error.code === 'cancelled'
  if (error instanceof Error && error.name === 'AbortError') return true
  return signal?.aborted ?? false
}

/** Provider 故障返回结构化状态；只有明确取消会中止整次 workflow attempt。 */
export class WebExtractService {
  constructor(private readonly extractor: WebPageExtractor) {}

  async extract(input: WebExtractProviderRequest): Promise<WebExtractResult> {
    const request = WebExtractRequestSchema.parse(input)
    try {
      return {
        status: 'ready',
        ...(await this.extractor.extract({
          ...request,
          signal: input.signal,
          effectScope: input.effectScope,
        })),
      }
    } catch (error) {
      if (isCancellation(error, input.signal)) throw error
      if (error instanceof WebExtractProviderError) {
        return {
          status: error.code === 'unavailable' ? 'unavailable' : 'failed',
          url: request.url,
          reason: error.code,
          retryable: error.retryable,
          ...(error.provider ? { provider: error.provider } : {}),
        }
      }
      return {
        status: 'failed',
        url: request.url,
        reason: 'provider_error',
        retryable: false,
      }
    }
  }
}
