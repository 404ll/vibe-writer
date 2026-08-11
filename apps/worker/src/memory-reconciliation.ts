import type {
  AuthorizedWorkspaceScope,
  MemoryExtractionLookupPreparation,
  ReconcileMemoryExtractionInput,
} from '@vibe-writer/db'
import {
  memoryModelUsageCost,
  type MemorySourcePointer,
} from '@vibe-writer/memory-core'
import {
  ProviderRequestLookupResultSchema,
  type ProviderRequestLookup,
} from '@vibe-writer/provider-runtime'

export type MemoryReconciliationRepositoryPort = {
  prepareLookup(
    scope: AuthorizedWorkspaceScope,
    input: { source: MemorySourcePointer; effectId: string; idempotencyKey: string },
  ): Promise<MemoryExtractionLookupPreparation>
  reconcile(
    scope: AuthorizedWorkspaceScope,
    input: ReconcileMemoryExtractionInput,
  ): Promise<{ status: 'reconciled'; reconciliation: unknown; replayed: boolean }>
}

export type LookupAndReconcileMemoryExtractionInput = {
  source: MemorySourcePointer
  effectId: string
  idempotencyKey: string
  confirmedFailure?: {
    retryDisposition: 'hold' | 'requeue'
    maxAttempts?: number
  }
  signal?: AbortSignal
}

export type LookupAndReconcileMemoryExtractionResult =
  | {
      status: 'unresolved'
      reason: 'missing_provider_request_id' | 'unsupported_provider' | 'pending' | 'not_found'
    }
  | {
      status: 'reconciled'
      providerStatus: 'succeeded' | 'failed'
      replayed: boolean
      reconciliation: unknown
    }

export class MemoryExtractionReconciliationService {
  private readonly lookups = new Map<string, ProviderRequestLookup>()

  constructor(
    private readonly repository: MemoryReconciliationRepositoryPort,
    lookups: readonly ProviderRequestLookup[],
  ) {
    for (const lookup of lookups) {
      const provider = lookup.provider.trim()
      if (!provider) throw new Error('Provider request lookup must have an identity')
      if (this.lookups.has(provider)) {
        throw new Error(`Duplicate provider request lookup for ${provider}`)
      }
      this.lookups.set(provider, lookup)
    }
  }

  async lookupAndReconcile(
    scope: AuthorizedWorkspaceScope,
    input: LookupAndReconcileMemoryExtractionInput,
  ): Promise<LookupAndReconcileMemoryExtractionResult> {
    const failure = input.confirmedFailure ?? { retryDisposition: 'hold' as const }
    if (failure.retryDisposition === 'hold' && failure.maxAttempts !== undefined) {
      throw new Error('maxAttempts is only valid for confirmed failure requeue')
    }
    if (
      failure.retryDisposition === 'requeue' &&
      (!Number.isInteger(failure.maxAttempts) || (failure.maxAttempts ?? 0) < 1 ||
        (failure.maxAttempts ?? 0) > 10)
    ) {
      throw new Error('Confirmed failure requeue requires maxAttempts between 1 and 10')
    }

    const preparation = await this.repository.prepareLookup(scope, {
      source: input.source,
      effectId: input.effectId,
      idempotencyKey: input.idempotencyKey,
    })
    if (preparation.status === 'already_reconciled') {
      if (
        preparation.providerStatus === 'failed' &&
        (preparation.reconciliation.retryDisposition !== failure.retryDisposition ||
          preparation.reconciliation.maxAttempts !==
            (failure.retryDisposition === 'requeue' ? failure.maxAttempts! : null))
      ) {
        throw new Error('Memory reconciliation idempotency collision')
      }
      return {
        status: 'reconciled',
        providerStatus: preparation.providerStatus,
        replayed: true,
        reconciliation: preparation.reconciliation,
      }
    }
    const target = preparation.target
    if (failure.retryDisposition === 'requeue' && target.sourceDeleted) {
      throw new Error('Erased Memory source cannot be requeued')
    }
    if (!target.providerRequestId) {
      return { status: 'unresolved', reason: 'missing_provider_request_id' }
    }
    const lookup = this.lookups.get(target.provider)
    if (!lookup) return { status: 'unresolved', reason: 'unsupported_provider' }

    const result = ProviderRequestLookupResultSchema.parse(await lookup.lookup({
      provider: target.provider,
      model: target.model,
      requestId: target.providerRequestId,
      ...(input.signal ? { signal: input.signal } : {}),
    }))
    if (
      result.provider !== target.provider ||
      result.model !== target.model ||
      result.requestId !== target.providerRequestId
    ) {
      throw new Error('Provider request lookup result identity collision')
    }
    if (result.status === 'pending' || result.status === 'not_found') {
      return { status: 'unresolved', reason: result.status }
    }

    const cost = target.budget
      ? {
          microusd: memoryModelUsageCost({
            usage: result.usage,
            pricing: target.budget.pricing,
          }),
          pricingVersion: target.budget.pricing.version,
          currency: 'USD' as const,
        }
      : undefined
    const resolution = await this.repository.reconcile(scope, {
      source: input.source,
      effectId: input.effectId,
      idempotencyKey: input.idempotencyKey,
      decision: result.status === 'succeeded' ? 'confirmed_succeeded' : 'confirmed_failed',
      retryDisposition: result.status === 'succeeded' ? 'hold' : failure.retryDisposition,
      ...(result.status === 'failed' && failure.retryDisposition === 'requeue'
        ? { maxAttempts: failure.maxAttempts }
        : {}),
      evidence: {
        kind: 'provider_lookup',
        fingerprint: result.evidenceFingerprint,
        providerRequestId: result.requestId,
      },
      reasonCode: result.status === 'succeeded'
        ? 'provider_lookup_confirmed_succeeded'
        : 'provider_lookup_confirmed_failed',
      usage: result.usage,
      ...(cost ? { cost } : {}),
    })
    return {
      status: 'reconciled',
      providerStatus: result.status,
      replayed: resolution.replayed,
      reconciliation: resolution.reconciliation,
    }
  }
}
