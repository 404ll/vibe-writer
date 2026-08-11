import {
  buildMemoryExtractorPrompt,
  composeModelMemoryProposals,
  estimateMemoryExtractionMaximumCost,
  MemoryExtractionBudgetPolicySchema,
  memoryModelUsageCost,
  type MemoryExtractionBudgetPolicy,
  type MemoryExtractionPromptInput,
  type MemorySourcePointer,
} from '@vibe-writer/memory-core'
import {
  fingerprintEffectRequest,
  type ClaimMemoryExtractionInput,
  type ClaimMemoryExtractionResult,
  type ClaimedOutboxEvent,
  type ClaimOutboxBatchInput,
  type FailMemoryExtractionClaimInput,
  type FinishMemoryExtractionEffectInput,
  type MemoryExtractionCompletionMetadata,
  type MemoryExtractionCost,
  type MemoryExtractionEffectMetadata,
  type MemoryExtractionExecutionSnapshot,
  type MemoryExtractionLeaseIdentity,
  type MemoryExtractionUsage,
  type OutboxLockIdentity,
  type ReserveMemoryExtractionEffectInput,
  type ReleaseOutboxFailureInput,
} from '@vibe-writer/db'
import {
  UnrecoverableQueueMessageError,
  type OutboxDispatchResult,
} from './outbox-dispatcher'

export const MEMORY_EXTRACTION_QUEUE_JOB_NAME = 'extract.memory'
export const MEMORY_EXTRACTION_JOB_SCHEMA_VERSION = 2 as const

export type MemoryExtractionQueueData = {
  schemaVersion: typeof MEMORY_EXTRACTION_JOB_SCHEMA_VERSION
  source: MemorySourcePointer
}

export type MemoryExtractionRunResult =
  | { status: 'not_found'; source: MemorySourcePointer }
  | { status: 'busy'; source: MemorySourcePointer }
  | {
      status: 'terminal'
      source: MemorySourcePointer
      taskStatus: 'failed' | 'uncertain' | 'cancelled'
    }
  | {
      status: 'completed'
      source: MemorySourcePointer
      proposalCount: number
      candidateCount: number
      conflictCount: number
      duplicateCount: number
      rejectedCount: number
      createdCount: number
      existingCount: number
    }

export type MemoryExtractionSource =
  | {
      kind: 'run'
      runId: string
      workspaceId: string
      topic: string
      content: string
      contentFingerprint: string
      retentionAnchor: Date | string
    }
  | {
      kind: 'signal'
      signalId: string
      workspaceId: string
      subjectKind: 'workspace' | 'principal' | 'project'
      subjectKey: string
      text: string
      evidenceFingerprint: string
      consentPolicyVersion: string
      retentionUntil: Date | string
    }

export type MemoryExtractionRepositoryPort = {
  loadExtractionSource(source: MemorySourcePointer): Promise<MemoryExtractionSource | null>
  submitProposal(proposal: unknown): Promise<
    | { status: 'candidate' | 'conflict'; created: boolean }
    | { status: 'duplicate' }
      | { status: 'rejected'; reason: string }
  >
  claimExtraction(input: ClaimMemoryExtractionInput): Promise<ClaimMemoryExtractionResult>
  heartbeatExtraction(
    identity: MemoryExtractionLeaseIdentity,
    leaseDurationMs: number,
  ): Promise<'renewed' | 'lease_lost'>
  reserveEffect(input: ReserveMemoryExtractionEffectInput): Promise<{
    status: 'reserved' | 'already_reserved' | 'succeeded' | 'failed' | 'uncertain' |
      'budget_rejected' | 'lease_lost'
    reason?: 'source_limit' | 'workspace_daily_limit' | 'workspace_policy_drift'
  }>
  finishEffect(input: FinishMemoryExtractionEffectInput): Promise<{
    status: 'finished' | 'replayed' | 'lease_lost'
  }>
  completeExtraction(
    identity: MemoryExtractionLeaseIdentity,
    result: MemoryExtractionCompletionMetadata,
  ): Promise<{ status: 'completed' | 'lease_lost' }>
  failExtraction(input: FailMemoryExtractionClaimInput): Promise<{
    status: 'retry_queued' | 'failed' | 'uncertain' | 'lease_lost'
  }>
}

export type MemoryExtractionProviderResult = {
  output: unknown
  provider: string
  model: string
  requestId?: string
  responseId?: string
  usage?: MemoryExtractionUsage
  cost?: MemoryExtractionCost
}

export type MemoryExtractor = {
  readonly maxOutputTokens?: number
  extract(input: {
    promptInput: MemoryExtractionPromptInput
    signal?: AbortSignal
  }): Promise<MemoryExtractionProviderResult>
}

export type MemoryExtractionServiceOptions = {
  extractorKey: string
  extractorVersion: string
  promptVersion: string
  consentPolicyVersion: string
  retentionDays: number
  modelProfile: {
    profile: string
    provider: string
    model: string
  }
  workerId: string
  leaseDurationMs: number
  heartbeatIntervalMs: number
  maxAttempts: number
  budget?: MemoryExtractionBudgetPolicy
}

function validDate(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('Memory source database clock is invalid')
  return parsed
}

export class MemoryExtractionService {
  constructor(
    private readonly repository: MemoryExtractionRepositoryPort,
    private readonly extractor: MemoryExtractor,
    private readonly options: MemoryExtractionServiceOptions,
  ) {
    if (
      !Number.isInteger(options.retentionDays) ||
      options.retentionDays < 1 ||
      options.retentionDays > 365
    ) {
      throw new Error('Memory retentionDays must be an integer between 1 and 365')
    }
    if (!options.workerId.trim()) throw new Error('Memory workerId is required')
    for (const key of ['leaseDurationMs', 'heartbeatIntervalMs', 'maxAttempts'] as const) {
      if (!Number.isInteger(options[key]) || options[key] <= 0) {
        throw new Error(`Memory ${key} must be a positive integer`)
      }
    }
    if (options.heartbeatIntervalMs >= options.leaseDurationMs) {
      throw new Error('Memory heartbeatIntervalMs must be shorter than leaseDurationMs')
    }
    if (
      options.budget &&
      this.extractor.maxOutputTokens !== options.budget.maxOutputTokens
    ) {
      throw new Error('Memory extractor maxOutputTokens must match its budget snapshot')
    }
    if (options.budget) MemoryExtractionBudgetPolicySchema.parse(options.budget)
  }

  async run(
    sourcePointer: MemorySourcePointer,
    signal?: AbortSignal,
  ): Promise<MemoryExtractionRunResult> {
    memoryExtractionQueueJobId(sourcePointer)
    const execution: MemoryExtractionExecutionSnapshot = {
      extractorKey: this.options.extractorKey,
      extractorVersion: this.options.extractorVersion,
      promptVersion: this.options.promptVersion,
      consentPolicyVersion: this.options.consentPolicyVersion,
      retentionDays: this.options.retentionDays,
      modelProfile: this.options.modelProfile,
      ...(this.options.budget ? { budget: this.options.budget } : {}),
    }
    const claim = await this.repository.claimExtraction({
      source: sourcePointer,
      workerId: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
      maxAttempts: this.options.maxAttempts,
      execution,
    })
    if (claim.status === 'not_found') return { status: 'not_found', source: sourcePointer }
    if (claim.status === 'busy') return { status: 'busy', source: sourcePointer }
    if (claim.status === 'terminal') {
      if (claim.taskStatus === 'completed') {
        return {
          status: 'completed',
          source: sourcePointer,
          ...completionMetadata(claim.resultMetadata),
        }
      }
      return { status: 'terminal', source: sourcePointer, taskStatus: claim.taskStatus }
    }

    const heartbeat = startMemoryHeartbeat(
      this.repository,
      claim.identity,
      this.options.heartbeatIntervalMs,
      this.options.leaseDurationMs,
      signal,
    )
    let effectState: 'none' | 'reserved' | 'succeeded' | 'failed' | 'uncertain' = 'none'
    let settled = false
    try {
      const source = await this.repository.loadExtractionSource(sourcePointer)
      if (!source) {
        const result = await this.repository.failExtraction({
          ...claim.identity,
          outcome: 'failed',
          retryable: false,
          maxAttempts: this.options.maxAttempts,
          errorCode: 'source_not_found',
          errorMessage: 'Memory extraction source was not found or has expired.',
        })
        settled = result.status !== 'lease_lost'
        throw new MemoryExtractionTerminalError(
          'source_not_found',
          'Memory extraction source was not found or has expired.',
        )
      }
      const effectKey = `model:memory-extract:attempt:${claim.attempt.attempt}`
      const promptInput: MemoryExtractionPromptInput = source.kind === 'run'
        ? {
            segments: [
              { id: 'job-topic', author: 'user', scope: 'task', text: source.topic },
              {
                id: 'generated-article',
                author: 'assistant',
                scope: 'task',
                text: source.content,
              },
            ],
          }
        : {
            segments: [{
              id: 'memory-signal',
              author: 'user',
              scope: 'durable',
              text: source.text,
            }],
          }
      const budgetReservation = this.options.budget
        ? (() => {
            const prompt = buildMemoryExtractorPrompt(promptInput)
            if (prompt.promptVersion !== this.options.promptVersion) {
              throw new Error('Memory budget prompt version does not match execution snapshot')
            }
            return {
              maximumCostMicrousd: estimateMemoryExtractionMaximumCost({
                inputUtf8Bytes: Buffer.byteLength(prompt.system, 'utf8') +
                  Buffer.byteLength(prompt.user, 'utf8'),
                policy: this.options.budget,
              }),
              policy: this.options.budget,
            }
          })()
        : undefined
      const evidenceFingerprint = source.kind === 'run'
        ? source.contentFingerprint
        : source.evidenceFingerprint
      const requestFingerprint = fingerprintEffectRequest({
        source: sourcePointer,
        evidenceFingerprint,
        extractorKey: this.options.extractorKey,
        extractorVersion: this.options.extractorVersion,
        promptVersion: this.options.promptVersion,
        modelProfile: this.options.modelProfile,
      })
      const reservation = await this.repository.reserveEffect({
        ...claim.identity,
        effectKey,
        requestFingerprint,
        provider: this.options.modelProfile.provider,
        model: this.options.modelProfile.model,
        ...(budgetReservation ? { budget: budgetReservation } : {}),
      })
      if (reservation.status === 'budget_rejected') {
        const result = await this.repository.failExtraction({
          ...claim.identity,
          outcome: 'failed',
          retryable: false,
          maxAttempts: this.options.maxAttempts,
          errorCode: `budget_${reservation.reason ?? 'rejected'}`,
          errorMessage: 'Memory extraction cost budget rejected the provider call.',
        })
        settled = result.status !== 'lease_lost'
        throw new MemoryExtractionTerminalError(
          `budget_${reservation.reason ?? 'rejected'}`,
          'Memory extraction cost budget rejected the provider call.',
        )
      }
      if (reservation.status !== 'reserved') {
        if (reservation.status === 'lease_lost') {
          throw new Error('Memory extraction lease was lost before provider reservation')
        }
        const result = await this.repository.failExtraction({
          ...claim.identity,
          outcome: 'uncertain',
          retryable: false,
          maxAttempts: this.options.maxAttempts,
          errorCode: 'effect_replay_blocked',
          errorMessage: `Provider effect replay was blocked at status ${reservation.status}.`,
        })
        settled = result.status !== 'lease_lost'
        throw new MemoryExtractionTerminalError(
          'effect_replay_blocked',
          'Memory extraction provider effect replay requires reconciliation.',
        )
      }
      effectState = 'reserved'

      const providerStartedAt = performance.now()
      let providerResult: MemoryExtractionProviderResult
      try {
        providerResult = await this.extractor.extract({
          promptInput,
          signal: heartbeat.signal,
        })
      } catch (error) {
        const failure = providerFailure(error)
        const finished = await this.repository.finishEffect({
          ...claim.identity,
          effectKey,
          outcome: failure.outcome,
          metadata: {
            provider: this.options.modelProfile.provider,
            model: this.options.modelProfile.model,
            latencyMs: Math.round(performance.now() - providerStartedAt),
          },
          errorCode: failure.code,
          errorMessage: failure.message,
        })
        if (finished.status === 'lease_lost') throw error
        effectState = failure.outcome
        const failed = await this.repository.failExtraction({
          ...claim.identity,
          outcome: failure.outcome,
          retryable: failure.retryable,
          maxAttempts: this.options.maxAttempts,
          errorCode: failure.code,
          errorMessage: failure.message,
        })
        settled = failed.status !== 'lease_lost'
        if (failed.status === 'retry_queued') throw error
        throw new MemoryExtractionTerminalError(failure.code, failure.message)
      }

      if (
        providerResult.provider !== this.options.modelProfile.provider ||
        providerResult.model !== this.options.modelProfile.model
      ) {
        await this.repository.finishEffect({
          ...claim.identity,
          effectKey,
          outcome: 'uncertain',
          errorCode: 'provider_identity_mismatch',
          errorMessage: 'Memory extraction provider identity did not match the execution snapshot.',
        })
        effectState = 'uncertain'
        const failed = await this.repository.failExtraction({
          ...claim.identity,
          outcome: 'uncertain',
          retryable: false,
          maxAttempts: this.options.maxAttempts,
          errorCode: 'provider_identity_mismatch',
          errorMessage: 'Memory extraction provider identity did not match the execution snapshot.',
        })
        settled = failed.status !== 'lease_lost'
        throw new MemoryExtractionTerminalError(
          'provider_identity_mismatch',
          'Memory extraction provider identity requires reconciliation.',
        )
      }
      let budgetCost: MemoryExtractionCost | undefined
      if (this.options.budget) {
        if (!providerResult.usage) {
          await this.repository.finishEffect({
            ...claim.identity,
            effectKey,
            outcome: 'uncertain',
            metadata: {
              provider: providerResult.provider,
              model: providerResult.model,
              ...(providerResult.requestId ? { requestId: providerResult.requestId } : {}),
              ...(providerResult.responseId ? { responseId: providerResult.responseId } : {}),
              latencyMs: Math.round(performance.now() - providerStartedAt),
            },
            errorCode: 'budget_usage_missing',
            errorMessage: 'Memory extraction provider omitted usage required for budget settlement.',
          })
          effectState = 'uncertain'
          const failed = await this.repository.failExtraction({
            ...claim.identity,
            outcome: 'uncertain',
            retryable: false,
            maxAttempts: this.options.maxAttempts,
            errorCode: 'budget_usage_missing',
            errorMessage: 'Memory extraction provider omitted usage required for budget settlement.',
          })
          settled = failed.status !== 'lease_lost'
          throw new MemoryExtractionTerminalError(
            'budget_usage_missing',
            'Memory extraction budget requires provider usage metadata.',
          )
        }
        budgetCost = {
          microusd: memoryModelUsageCost({
            usage: providerResult.usage,
            pricing: this.options.budget.pricing,
          }),
          pricingVersion: this.options.budget.pricing.version,
          currency: 'USD',
        }
        if (
          budgetReservation &&
          budgetCost.microusd > budgetReservation.maximumCostMicrousd
        ) {
          await this.repository.finishEffect({
            ...claim.identity,
            effectKey,
            outcome: 'uncertain',
            metadata: {
              provider: providerResult.provider,
              model: providerResult.model,
              ...(providerResult.requestId ? { requestId: providerResult.requestId } : {}),
              ...(providerResult.responseId ? { responseId: providerResult.responseId } : {}),
              usage: providerResult.usage,
              cost: budgetCost,
              latencyMs: Math.round(performance.now() - providerStartedAt),
            },
            errorCode: 'budget_reservation_exceeded',
            errorMessage: 'Provider usage exceeded the reserved Memory extraction cost.',
          })
          effectState = 'uncertain'
          const failed = await this.repository.failExtraction({
            ...claim.identity,
            outcome: 'uncertain',
            retryable: false,
            maxAttempts: this.options.maxAttempts,
            errorCode: 'budget_reservation_exceeded',
            errorMessage: 'Provider usage exceeded the reserved Memory extraction cost.',
          })
          settled = failed.status !== 'lease_lost'
          throw new MemoryExtractionTerminalError(
            'budget_reservation_exceeded',
            'Memory extraction usage exceeded its hard reservation.',
          )
        }
      }
      const effectMetadata: MemoryExtractionEffectMetadata = {
        provider: providerResult.provider,
        model: providerResult.model,
        ...(providerResult.requestId ? { requestId: providerResult.requestId } : {}),
        ...(providerResult.responseId ? { responseId: providerResult.responseId } : {}),
        ...(providerResult.usage ? { usage: providerResult.usage } : {}),
        ...(budgetCost
          ? { cost: budgetCost }
          : providerResult.cost ? { cost: providerResult.cost } : {}),
        latencyMs: Math.round(performance.now() - providerStartedAt),
      }
      const finished = await this.repository.finishEffect({
        ...claim.identity,
        effectKey,
        outcome: 'succeeded',
        metadata: effectMetadata,
      })
      if (finished.status === 'lease_lost') {
        throw new Error('Memory extraction lease was lost after provider success')
      }
      effectState = 'succeeded'

      const expiresAt = source.kind === 'run'
        ? new Date(
            validDate(source.retentionAnchor).getTime() +
            this.options.retentionDays * 86_400_000,
          ).toISOString()
        : validDate(source.retentionUntil).toISOString()
      const proposals = composeModelMemoryProposals({
        envelope: {
          workspaceId: source.workspaceId,
          source: source.kind === 'run'
            ? {
                kind: 'run',
                runId: source.runId,
                evidenceFingerprint: source.contentFingerprint,
              }
            : {
                kind: 'signal',
                signalId: source.signalId,
                evidenceFingerprint: source.evidenceFingerprint,
              },
          ...(source.kind === 'signal'
            ? { subject: { kind: source.subjectKind, key: source.subjectKey } }
            : {}),
          extractor: {
            key: this.options.extractorKey,
            version: this.options.extractorVersion,
          },
          consent: source.kind === 'run'
            ? {
                basis: 'workspace_policy',
                policyVersion: this.options.consentPolicyVersion,
              }
            : {
                basis: 'explicit_user',
                policyVersion: source.consentPolicyVersion,
              },
          expiresAt,
        },
        modelOutput: providerResult.output,
      })
      const counts = {
        candidateCount: 0,
        conflictCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        createdCount: 0,
        existingCount: 0,
      }
      for (const proposal of proposals) {
        const result = await this.repository.submitProposal(proposal)
        if (result.status === 'candidate') counts.candidateCount += 1
        if (result.status === 'conflict') counts.conflictCount += 1
        if (result.status === 'duplicate') counts.duplicateCount += 1
        if (result.status === 'rejected') counts.rejectedCount += 1
        if ('created' in result) {
          if (result.created) counts.createdCount += 1
          else counts.existingCount += 1
        }
      }
      const completion = { proposalCount: proposals.length, ...counts }
      const completed = await this.repository.completeExtraction(claim.identity, completion)
      if (completed.status === 'lease_lost') {
        throw new Error('Memory extraction lease was lost before completion')
      }
      settled = true
      return { status: 'completed', source: sourcePointer, ...completion }
    } catch (error) {
      if (!settled) {
        const outcome = effectState === 'none'
          ? 'failed' as const
          : 'uncertain' as const
        const failed = await this.repository.failExtraction({
          ...claim.identity,
          outcome,
          retryable: outcome === 'failed',
          maxAttempts: this.options.maxAttempts,
          errorCode: outcome === 'failed' ? 'extraction_failed' : 'post_provider_failure',
          errorMessage: outcome === 'failed'
            ? 'Memory extraction failed before provider success.'
            : 'Memory extraction failed after the provider effect may have succeeded.',
        })
        settled = failed.status !== 'lease_lost'
        if (failed.status !== 'retry_queued' && failed.status !== 'lease_lost') {
          throw new MemoryExtractionTerminalError(
            failed.status,
            'Memory extraction requires terminal reconciliation.',
          )
        }
      }
      throw error
    } finally {
      await heartbeat.stop()
    }
  }
}

export class MemoryExtractionTerminalError extends Error {
  readonly name = 'MemoryExtractionTerminalError'
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export class MemoryExtractionProviderError extends Error {
  readonly name = 'MemoryExtractionProviderError'
  constructor(
    readonly code: string,
    message: string,
    readonly options: { outcome: 'failed' | 'uncertain'; retryable: boolean },
  ) {
    super(message)
  }
}

function providerFailure(error: unknown) {
  if (error instanceof MemoryExtractionProviderError) {
    return {
      code: error.code.slice(0, 256),
      message: `Memory extraction provider failed: ${error.code.slice(0, 256)}`,
      outcome: error.options.outcome,
      retryable: error.options.retryable,
    }
  }
  return {
    code: 'provider_outcome_unknown',
    message: 'Memory extraction provider outcome is unknown.',
    outcome: 'uncertain' as const,
    retryable: false,
  }
}

function completionMetadata(value: Record<string, unknown> | null): MemoryExtractionCompletionMetadata {
  if (!value) throw new Error('Completed Memory extraction is missing result metadata')
  const keys = [
    'proposalCount',
    'candidateCount',
    'conflictCount',
    'duplicateCount',
    'rejectedCount',
    'createdCount',
    'existingCount',
  ] as const
  const result = {} as MemoryExtractionCompletionMetadata
  for (const key of keys) {
    const count = value[key]
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`Completed Memory extraction has invalid ${key}`)
    }
    result[key] = count as number
  }
  return result
}

function startMemoryHeartbeat(
  repository: Pick<MemoryExtractionRepositoryPort, 'heartbeatExtraction'>,
  identity: MemoryExtractionLeaseIdentity,
  intervalMs: number,
  leaseDurationMs: number,
  parentSignal?: AbortSignal,
) {
  const controller = new AbortController()
  let stopped = false
  let pending = Promise.resolve()
  const abortFromParent = () => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      if (stopped) return
      try {
        const status = await repository.heartbeatExtraction(identity, leaseDurationMs)
        if (status === 'lease_lost' && !controller.signal.aborted) {
          controller.abort(new Error('Memory extraction lease lost'))
        }
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error)
      }
    })
  }, intervalMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    async stop() {
      stopped = true
      clearInterval(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
      await pending
    },
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function sourceId(source: MemorySourcePointer): string {
  return source.kind === 'run' ? source.runId : source.signalId
}

function parseSourcePointer(value: unknown): MemorySourcePointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Memory extraction source must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    record.kind === 'run' && keys.length === 2 && keys[0] === 'kind' &&
    keys[1] === 'runId' && typeof record.runId === 'string' &&
    UUID_PATTERN.test(record.runId)
  ) {
    return { kind: 'run', runId: record.runId }
  }
  if (
    record.kind === 'signal' && keys.length === 2 && keys[0] === 'kind' &&
    keys[1] === 'signalId' && typeof record.signalId === 'string' &&
    UUID_PATTERN.test(record.signalId)
  ) {
    return { kind: 'signal', signalId: record.signalId }
  }
  throw new Error('Memory extraction source has an unsupported identity')
}

export function memoryExtractionQueueJobId(source: MemorySourcePointer): string {
  const id = sourceId(source)
  if (!UUID_PATTERN.test(id)) throw new Error('Memory extraction source id must be a UUID')
  return `memory-${source.kind}-${id.toLowerCase()}`
}

function parseQueueData(value: unknown): MemoryExtractionQueueData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnrecoverableQueueMessageError('Memory extraction payload must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length === 2 && keys[0] === 'runId' && keys[1] === 'schemaVersion' &&
    record.schemaVersion === 1 && typeof record.runId === 'string'
  ) {
    try {
      const source = parseSourcePointer({ kind: 'run', runId: record.runId })
      return { schemaVersion: MEMORY_EXTRACTION_JOB_SCHEMA_VERSION, source }
    } catch {
      throw new UnrecoverableQueueMessageError('Memory extraction source id must be a UUID')
    }
  }
  if (
    keys.length !== 2 ||
    keys[0] !== 'schemaVersion' ||
    keys[1] !== 'source' ||
    record.schemaVersion !== MEMORY_EXTRACTION_JOB_SCHEMA_VERSION ||
    !record.source
  ) {
    throw new UnrecoverableQueueMessageError('Unsupported Memory extraction payload schema')
  }
  try {
    const source = parseSourcePointer(record.source)
    memoryExtractionQueueJobId(source)
    return { schemaVersion: MEMORY_EXTRACTION_JOB_SCHEMA_VERSION, source }
  } catch {
    throw new UnrecoverableQueueMessageError('Memory extraction source has an invalid identity')
  }
}

export async function processMemoryExtractionQueueJob(
  job: { name: string; data: unknown },
  service: Pick<MemoryExtractionService, 'run'>,
): Promise<MemoryExtractionRunResult> {
  if (job.name !== MEMORY_EXTRACTION_QUEUE_JOB_NAME) {
    throw new UnrecoverableQueueMessageError(`Unsupported queue job ${job.name}`)
  }
  const data = parseQueueData(job.data)
  return service.run(data.source)
}

export type MemoryOutboxDispatchControl = {
  claimBatch(input: ClaimOutboxBatchInput): Promise<ClaimedOutboxEvent[]>
  markPublished(identity: OutboxLockIdentity): Promise<'published' | 'lease_lost'>
  releaseFailure(input: ReleaseOutboxFailureInput): Promise<'released' | 'lease_lost'>
}

export type MemoryExtractionPublisher = {
  enqueue(
    name: typeof MEMORY_EXTRACTION_QUEUE_JOB_NAME,
    data: MemoryExtractionQueueData,
    options: { jobId: string },
  ): Promise<void>
}

export type MemoryOutboxDispatcherOptions = {
  dispatcherId: string
  batchSize: number
  lockTimeoutMs: number
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  now?: () => Date
}

function queueData(event: ClaimedOutboxEvent): MemoryExtractionQueueData {
  if (
    event.aggregateType !== 'memory_extraction' ||
    event.eventType !== 'memory.extraction.requested'
  ) {
    throw new Error(`Unsupported Memory outbox event ${event.aggregateType}/${event.eventType}`)
  }
  const keys = Object.keys(event.payload).sort()
  if (
    keys.length === 1 && keys[0] === 'runId' &&
    typeof event.payload.runId === 'string' && event.payload.runId === event.aggregateId
  ) {
    const source = parseSourcePointer({ kind: 'run', runId: event.payload.runId })
    return { schemaVersion: MEMORY_EXTRACTION_JOB_SCHEMA_VERSION, source }
  }
  if (
    keys.length !== 2 || keys[0] !== 'schemaVersion' || keys[1] !== 'source' ||
    event.payload.schemaVersion !== MEMORY_EXTRACTION_JOB_SCHEMA_VERSION
  ) {
    throw new Error('Memory outbox payload must contain a versioned source pointer')
  }
  const source = parseSourcePointer(event.payload.source)
  if (sourceId(source) !== event.aggregateId) {
    throw new Error('Memory outbox source must match aggregateId')
  }
  memoryExtractionQueueJobId(source)
  return { schemaVersion: MEMORY_EXTRACTION_JOB_SCHEMA_VERSION, source }
}

export class MemoryOutboxDispatcher {
  private readonly now: () => Date

  constructor(
    private readonly control: MemoryOutboxDispatchControl,
    private readonly publisher: MemoryExtractionPublisher,
    private readonly options: MemoryOutboxDispatcherOptions,
  ) {
    if (!options.dispatcherId.trim()) throw new Error('dispatcherId is required')
    for (const key of [
      'batchSize',
      'lockTimeoutMs',
      'maxAttempts',
      'initialBackoffMs',
      'maxBackoffMs',
    ] as const) {
      if (!Number.isInteger(options[key]) || options[key] <= 0) {
        throw new Error(`${key} must be positive`)
      }
    }
    this.now = options.now ?? (() => new Date())
  }

  async dispatchBatch(): Promise<OutboxDispatchResult[]> {
    const events = await this.control.claimBatch({
      dispatcherId: this.options.dispatcherId,
      aggregateType: 'memory_extraction',
      limit: this.options.batchSize,
      lockTimeoutMs: this.options.lockTimeoutMs,
    })
    return Promise.all(events.map(async (event) => {
      const identity = { eventId: event.id, lockToken: event.lockToken }
      try {
        const data = queueData(event)
        const queueJobId = memoryExtractionQueueJobId(data.source)
        await this.publisher.enqueue(
          MEMORY_EXTRACTION_QUEUE_JOB_NAME,
          data,
          { jobId: queueJobId },
        )
        const marked = await this.control.markPublished(identity)
        return marked === 'published'
          ? { eventId: event.id, status: 'published' as const, queueJobId }
          : { eventId: event.id, status: 'lease_lost' as const }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Memory publish failed.'
        const terminal = event.attempts >= this.options.maxAttempts ||
          message.startsWith('Unsupported Memory outbox') ||
          message.startsWith('Memory outbox payload') ||
          message.startsWith('Memory extraction source')
        const delay = Math.min(
          this.options.maxBackoffMs,
          this.options.initialBackoffMs * 2 ** Math.max(0, event.attempts - 1),
        )
        const released = await this.control.releaseFailure({
          ...identity,
          error: message,
          retryAt: new Date(this.now().getTime() + delay),
          terminal,
        })
        return released === 'lease_lost'
          ? { eventId: event.id, status: 'lease_lost' as const }
          : {
              eventId: event.id,
              status: terminal ? 'failed' as const : 'retry_scheduled' as const,
            }
      }
    }))
  }
}
