import type {
  SearchProvider,
  SearchProviderRequest,
  WebExtractProviderRequest,
  WebPageExtractor,
} from '@vibe-writer/agent-core'
import {
  fingerprintEffectRequest,
  type CanonicalJsonObject,
  type FinishRunEffectInput,
  type FinishRunEffectResult,
  type LeaseIdentity,
  type ReserveRunEffectInput,
  type ReserveRunEffectResult,
} from '@vibe-writer/db'
import {
  type TextModel,
  type TextModelRequest,
  type ToolModel,
  type ToolModelRequest,
} from '@vibe-writer/model-runtime'

export type EffectJournalControl = {
  reserveRunEffect(input: ReserveRunEffectInput): Promise<ReserveRunEffectResult>
  finishRunEffect(input: FinishRunEffectInput): Promise<FinishRunEffectResult>
}

export class EffectJournalError extends Error {
  readonly name = 'EffectJournalError'
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function scope(metadata: Record<string, unknown> | undefined): string {
  const value = metadata?.effectScope
  if (typeof value !== 'string' || !value.trim()) {
    throw new EffectJournalError('missing_effect_scope', 'Provider request is missing its durable effect scope')
  }
  return value
}

function requestError(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String((error as { code: unknown }).code).slice(0, 100)
    return { code, message: `Provider request failed: ${code}` }
  }
  return { code: 'provider_error', message: 'Provider request failed.' }
}

function resultMetadata(response: {
  provider: string
  model?: string
  requestId?: string
  responseId?: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number }
}, latencyMs: number, extra: CanonicalJsonObject = {}): CanonicalJsonObject {
  return {
    provider: response.provider,
    ...(response.model ? { model: response.model } : {}),
    ...(response.requestId ? { requestId: response.requestId } : {}),
    ...(response.responseId ? { responseId: response.responseId } : {}),
    ...(response.usage ? { usage: response.usage } : {}),
    latencyMs,
    ...extra,
  }
}

// Checkpoint 只能恢复内部 State，不能撤销已经发给模型或搜索供应商的请求。
// Effect Journal 在外部调用前预留稳定 effectKey、调用后记录结果；遇到重复或
// 结果不确定时 fail closed。它降低重复计费风险，但不宣称提供 Exactly Once。
abstract class EffectJournalBase {
  constructor(
    protected readonly journal: EffectJournalControl,
    protected readonly identity: LeaseIdentity,
  ) {}

  protected async reserve(input: Omit<ReserveRunEffectInput, keyof LeaseIdentity>) {
    const result = await this.journal.reserveRunEffect({ ...this.identity, ...input })
    if (result.status !== 'reserved') {
      throw new EffectJournalError(
        `effect_${result.status}`,
        `External effect cannot execute after reservation status ${result.status}`,
      )
    }
  }

  protected async finish(input: Omit<FinishRunEffectInput, keyof LeaseIdentity>) {
    const result = await this.journal.finishRunEffect({ ...this.identity, ...input })
    if (result.status !== 'finished' && result.status !== 'replayed') {
      throw new EffectJournalError(
        `effect_${result.status}`,
        `External effect result lost its fenced owner: ${result.status}`,
      )
    }
  }
}

export class EffectJournalModel extends EffectJournalBase implements TextModel, ToolModel {
  private readonly calls = new Map<string, number>()

  constructor(
    private readonly model: TextModel & ToolModel,
    journal: EffectJournalControl,
    identity: LeaseIdentity,
  ) {
    super(journal, identity)
  }

  async generate(request: TextModelRequest) {
    return this.callText(request, `model:${scope(request.metadata)}`)
  }

  async generateWithTools(request: ToolModelRequest) {
    const base = scope(request.metadata)
    const ordinal = (this.calls.get(base) ?? 0) + 1
    this.calls.set(base, ordinal)
    const effectKey = `model:${base}:request:${ordinal}`
    const fingerprint = fingerprintEffectRequest({
      operation: request.operation,
      promptVersion: request.promptVersion,
      toolsetVersion: request.toolsetVersion,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      maxTokens: request.maxTokens,
      metadata: request.metadata ?? {},
    })
    await this.reserve({
      effectKey,
      effectType: 'model_call',
      requestFingerprint: fingerprint,
      trace: { operation: request.operation },
    })
    const started = performance.now()
    let response
    try {
      response = await this.model.generateWithTools(request)
    } catch (error) {
      const detail = requestError(error)
      await this.finish({ effectKey, outcome: 'failed', errorCode: detail.code, errorMessage: detail.message })
      throw error
    }
    await this.finish({
      effectKey,
      outcome: 'succeeded',
      resultMetadata: resultMetadata(response, Math.round(performance.now() - started), {
        stopReason: response.stopReason,
      }),
    })
    return response
  }

  private async callText(request: TextModelRequest, effectKey: string) {
    const fingerprint = fingerprintEffectRequest({
      operation: request.operation,
      promptVersion: request.promptVersion,
      system: request.system,
      user: request.user,
      maxTokens: request.maxTokens,
      metadata: request.metadata ?? {},
    })
    await this.reserve({
      effectKey,
      effectType: 'model_call',
      requestFingerprint: fingerprint,
      trace: { operation: request.operation },
    })
    const started = performance.now()
    let response
    try {
      response = await this.model.generate(request)
    } catch (error) {
      const detail = requestError(error)
      await this.finish({ effectKey, outcome: 'failed', errorCode: detail.code, errorMessage: detail.message })
      throw error
    }
    await this.finish({
      effectKey,
      outcome: 'succeeded',
      resultMetadata: resultMetadata(response, Math.round(performance.now() - started), {
        finishReason: response.finishReason,
      }),
    })
    return response
  }
}

export class EffectJournalSearchProvider extends EffectJournalBase implements SearchProvider {
  constructor(
    private readonly provider: SearchProvider,
    journal: EffectJournalControl,
    identity: LeaseIdentity,
  ) {
    super(journal, identity)
  }

  async search(request: SearchProviderRequest) {
    const effectKey = `search:${scope(request)}`
    const fingerprint = fingerprintEffectRequest({
      query: request.query,
      topic: request.topic,
      searchDepth: request.searchDepth,
      maxResults: request.maxResults,
      ...(request.startDate ? { startDate: request.startDate } : {}),
      ...(request.endDate ? { endDate: request.endDate } : {}),
    })
    await this.reserve({
      effectKey,
      effectType: 'search',
      requestFingerprint: fingerprint,
      trace: { operation: 'search.query' },
    })
    const started = performance.now()
    let response
    try {
      response = await this.provider.search(request)
    } catch (error) {
      const detail = requestError(error)
      await this.finish({ effectKey, outcome: 'failed', errorCode: detail.code, errorMessage: detail.message })
      throw error
    }
    await this.finish({
      effectKey,
      outcome: 'succeeded',
      resultMetadata: {
        provider: response.provider,
        ...(response.requestId ? { requestId: response.requestId } : {}),
        documentCount: response.documents.length,
        latencyMs: Math.round(performance.now() - started),
      },
    })
    return response
  }
}

/** 网页读取同样经过 lease/fencing；journal 只保存长度和类型，不保存 URL 或正文。 */
export class EffectJournalWebPageExtractor extends EffectJournalBase implements WebPageExtractor {
  constructor(
    private readonly extractor: WebPageExtractor,
    journal: EffectJournalControl,
    identity: LeaseIdentity,
  ) {
    super(journal, identity)
  }

  async extract(request: WebExtractProviderRequest) {
    const effectKey = `tool:${scope(request)}:web-extract`
    const fingerprint = fingerprintEffectRequest({ url: request.url })
    await this.reserve({
      effectKey,
      effectType: 'tool_call',
      requestFingerprint: fingerprint,
      trace: { operation: 'web.extract' },
    })
    const started = performance.now()
    let response
    try {
      response = await this.extractor.extract(request)
    } catch (error) {
      const detail = requestError(error)
      await this.finish({ effectKey, outcome: 'failed', errorCode: detail.code, errorMessage: detail.message })
      throw error
    }
    await this.finish({
      effectKey,
      outcome: 'succeeded',
      resultMetadata: {
        provider: response.provider,
        contentType: response.contentType,
        contentLength: response.content.length,
        truncated: response.truncated,
        latencyMs: Math.round(performance.now() - started),
      },
    })
    return response
  }
}
