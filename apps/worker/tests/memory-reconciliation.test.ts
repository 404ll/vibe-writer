import { randomUUID } from 'node:crypto'
import type {
  AuthorizedWorkspaceScope,
  MemoryExtractionLookupTarget,
  ReconcileMemoryExtractionInput,
} from '@vibe-writer/db'
import type { ProviderRequestLookup } from '@vibe-writer/provider-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  MemoryExtractionReconciliationService,
  type MemoryReconciliationRepositoryPort,
} from '../src/memory-reconciliation'

const scope: AuthorizedWorkspaceScope = {
  workspaceId: randomUUID(),
  principalId: randomUUID(),
  authorization: 'verified-membership',
  role: 'owner',
}
const source = { kind: 'run' as const, runId: randomUUID() }
const budget = {
  policyVersion: 'memory-budget-v1',
  maxSourceCostMicrousd: 1_000,
  maxWorkspaceDailyCostMicrousd: 10_000,
  maxOutputTokens: 128,
  pricing: {
    version: 'pricing-v1',
    inputMicrousdPerMillionTokens: 1_000,
    outputMicrousdPerMillionTokens: 2_000,
    cacheReadMicrousdPerMillionTokens: 100,
    cacheWriteMicrousdPerMillionTokens: 1_250,
  },
}

function target(overrides: Partial<MemoryExtractionLookupTarget> = {}): MemoryExtractionLookupTarget {
  return {
    source,
    sourceDeleted: false,
    effectId: randomUUID(),
    provider: 'scripted',
    model: 'memory-v1',
    providerRequestId: 'request-1',
    providerResponseId: null,
    budget,
    ...overrides,
  }
}

function harness(
  lookupResult: Awaited<ReturnType<ProviderRequestLookup['lookup']>>,
  targetValue = target(),
) {
  const reconcile = vi.fn(async (_scope: AuthorizedWorkspaceScope, input: ReconcileMemoryExtractionInput) => ({
    status: 'reconciled' as const,
    replayed: false,
    reconciliation: { id: 'reconciliation-1', input },
  }))
  const repository: MemoryReconciliationRepositoryPort = {
    prepareLookup: vi.fn(async () => ({ status: 'lookup_required' as const, target: targetValue })),
    reconcile,
  }
  const lookup: ProviderRequestLookup = {
    provider: 'scripted',
    lookup: vi.fn(async () => lookupResult),
  }
  return {
    service: new MemoryExtractionReconciliationService(repository, [lookup]),
    repository,
    reconcile,
    lookup,
    target: targetValue,
  }
}

describe('Memory provider lookup reconciliation service', () => {
  it('settles confirmed success using the reservation pricing snapshot', async () => {
    const evidenceFingerprint = `sha256:${'a'.repeat(64)}`
    const setup = harness({
      status: 'succeeded', provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
      evidenceFingerprint,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
    })
    await expect(setup.service.lookupAndReconcile(scope, {
      source, effectId: setup.target.effectId, idempotencyKey: 'lookup-success-1',
    })).resolves.toMatchObject({
      status: 'reconciled', providerStatus: 'succeeded', replayed: false,
    })
    expect(setup.reconcile).toHaveBeenCalledWith(scope, expect.objectContaining({
      decision: 'confirmed_succeeded',
      retryDisposition: 'hold',
      evidence: { kind: 'provider_lookup', fingerprint: evidenceFingerprint, providerRequestId: 'request-1' },
      cost: { microusd: 3, pricingVersion: 'pricing-v1', currency: 'USD' },
    }))
  })

  it('only requeues confirmed failure when the owner supplies an explicit bound', async () => {
    const setup = harness({
      status: 'failed', provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
      evidenceFingerprint: `sha256:${'b'.repeat(64)}`,
      failureCode: 'provider_terminal_error',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    await setup.service.lookupAndReconcile(scope, {
      source,
      effectId: setup.target.effectId,
      idempotencyKey: 'lookup-failure-1',
      confirmedFailure: { retryDisposition: 'requeue', maxAttempts: 3 },
    })
    expect(setup.reconcile).toHaveBeenCalledWith(scope, expect.objectContaining({
      decision: 'confirmed_failed', retryDisposition: 'requeue', maxAttempts: 3,
      cost: { microusd: 0, pricingVersion: 'pricing-v1', currency: 'USD' },
    }))
  })

  it.each(['pending', 'not_found'] as const)(
    'does not mutate the ledger when lookup is %s',
    async (status) => {
      const setup = harness({
        status, provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
      })
      await expect(setup.service.lookupAndReconcile(scope, {
        source, effectId: setup.target.effectId, idempotencyKey: `lookup-${status}`,
      })).resolves.toEqual({ status: 'unresolved', reason: status })
      expect(setup.reconcile).not.toHaveBeenCalled()
    },
  )

  it('does not call a provider without a request id or installed adapter', async () => {
    const missing = harness({
      status: 'not_found', provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
    }, target({ providerRequestId: null }))
    await expect(missing.service.lookupAndReconcile(scope, {
      source, effectId: missing.target.effectId, idempotencyKey: 'lookup-missing-id',
    })).resolves.toEqual({ status: 'unresolved', reason: 'missing_provider_request_id' })
    expect(missing.lookup.lookup).not.toHaveBeenCalled()

    const unsupportedTarget = target({ provider: 'not-installed' })
    const unsupportedRepository: MemoryReconciliationRepositoryPort = {
      prepareLookup: vi.fn(async () => ({
        status: 'lookup_required' as const, target: unsupportedTarget,
      })),
      reconcile: vi.fn(),
    }
    const service = new MemoryExtractionReconciliationService(unsupportedRepository, [])
    await expect(service.lookupAndReconcile(scope, {
      source, effectId: unsupportedTarget.effectId, idempotencyKey: 'lookup-unsupported',
    })).resolves.toEqual({ status: 'unresolved', reason: 'unsupported_provider' })
    expect(unsupportedRepository.reconcile).not.toHaveBeenCalled()
  })

  it('does not mutate on transport failure or response identity drift', async () => {
    const setup = harness({
      status: 'succeeded', provider: 'scripted', model: 'other-model', requestId: 'request-1',
      evidenceFingerprint: `sha256:${'c'.repeat(64)}`,
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await expect(setup.service.lookupAndReconcile(scope, {
      source, effectId: setup.target.effectId, idempotencyKey: 'lookup-drift',
    })).rejects.toThrow('identity collision')
    expect(setup.reconcile).not.toHaveBeenCalled()

    const transport = harness({
      status: 'pending', provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
    })
    vi.mocked(transport.lookup.lookup).mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(transport.service.lookupAndReconcile(scope, {
      source, effectId: transport.target.effectId, idempotencyKey: 'lookup-transport',
    })).rejects.toThrow('provider unavailable')
    expect(transport.reconcile).not.toHaveBeenCalled()
  })

  it('rejects erased-source requeue before making a network lookup', async () => {
    const setup = harness({
      status: 'failed', provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
      evidenceFingerprint: `sha256:${'d'.repeat(64)}`,
      failureCode: 'provider_terminal_error', usage: { inputTokens: 0, outputTokens: 0 },
    }, target({ sourceDeleted: true }))
    await expect(setup.service.lookupAndReconcile(scope, {
      source,
      effectId: setup.target.effectId,
      idempotencyKey: 'lookup-erased-requeue',
      confirmedFailure: { retryDisposition: 'requeue', maxAttempts: 3 },
    })).rejects.toThrow('Erased Memory source cannot be requeued')
    expect(setup.lookup.lookup).not.toHaveBeenCalled()
    expect(setup.reconcile).not.toHaveBeenCalled()
  })

  it('replays a completed operation without querying the provider again', async () => {
    const setup = harness({
      status: 'pending', provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
    })
    vi.mocked(setup.repository.prepareLookup).mockResolvedValueOnce({
      status: 'already_reconciled',
      providerStatus: 'succeeded',
      reconciliation: {
        id: 'reconciliation-1',
        retryDisposition: 'hold',
        maxAttempts: null,
      } as never,
    })
    await expect(setup.service.lookupAndReconcile(scope, {
      source, effectId: setup.target.effectId, idempotencyKey: 'lookup-replay',
    })).resolves.toMatchObject({
      status: 'reconciled', providerStatus: 'succeeded', replayed: true,
      reconciliation: { id: 'reconciliation-1' },
    })
    expect(setup.lookup.lookup).not.toHaveBeenCalled()
    expect(setup.reconcile).not.toHaveBeenCalled()
  })

  it('rejects a changed retry intent under a completed idempotency key', async () => {
    const setup = harness({
      status: 'pending', provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
    })
    vi.mocked(setup.repository.prepareLookup).mockResolvedValueOnce({
      status: 'already_reconciled',
      providerStatus: 'failed',
      reconciliation: {
        id: 'reconciliation-1',
        retryDisposition: 'hold',
        maxAttempts: null,
      } as never,
    })
    await expect(setup.service.lookupAndReconcile(scope, {
      source,
      effectId: setup.target.effectId,
      idempotencyKey: 'lookup-changed-retry',
      confirmedFailure: { retryDisposition: 'requeue', maxAttempts: 3 },
    })).rejects.toThrow('idempotency collision')
    expect(setup.lookup.lookup).not.toHaveBeenCalled()
    expect(setup.reconcile).not.toHaveBeenCalled()
  })
})
