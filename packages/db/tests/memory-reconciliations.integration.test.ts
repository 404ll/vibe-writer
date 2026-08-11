import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createJobRepository,
  createMemoryExtractionReconciliationRepository,
  createMemoryExtractionRepository,
  createMemorySourceSignalRepository,
  createTerminalRepository,
  createWorkspaceRepository,
  fingerprintEffectRequest,
  WorkspacePermissionError,
} from '../src'
import * as schema from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
let client: PGlite
let db: ReturnType<typeof drizzle<typeof schema>>

const budget = {
  policyVersion: 'memory-reconciliation-budget-v1',
  maxSourceCostMicrousd: 1_000,
  maxWorkspaceDailyCostMicrousd: 10_000,
  maxOutputTokens: 128,
  pricing: {
    version: 'memory-reconciliation-pricing-v1',
    inputMicrousdPerMillionTokens: 1_000,
    outputMicrousdPerMillionTokens: 2_000,
    cacheReadMicrousdPerMillionTokens: 100,
    cacheWriteMicrousdPerMillionTokens: 1_250,
  },
}

const execution = {
  extractorKey: 'reconciliation-extractor',
  extractorVersion: 'v1',
  promptVersion: '2026-08-07-v1',
  consentPolicyVersion: 'workspace-memory-v1',
  retentionDays: 30,
  modelProfile: {
    profile: 'reconciliation-memory',
    provider: 'scripted',
    model: 'scripted-memory-v1',
  },
  budget,
}

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      memory_extraction_reconciliations, memory_extraction_effects,
      memory_extraction_attempts, memory_extraction_tasks,
      memory_source_signal_tombstones, memory_source_signals,
      memory_tombstones, memory_candidate_events, memory_revisions, memories,
      memory_candidates, article_versions, articles, job_commands, job_interrupts,
      checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function ownerScope() {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId: randomUUID(),
    slug: `memory-reconciliation-${randomUUID().slice(0, 8)}`,
    name: 'Memory reconciliation',
  })
}

async function completedRun(owner: Awaited<ReturnType<typeof ownerScope>>) {
  const jobs = createJobRepository(db)
  const { job } = await jobs.createJob({
    workspaceId: owner.workspaceId,
    createdByPrincipalId: owner.principalId,
    idempotencyKey: `reconciliation-source-${randomUUID()}`,
    topic: 'Private reconciliation source',
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: 'reconciliation-source-worker',
    leaseDurationMs: 30_000,
    execution: {
      modelProfile: { profile: 'scripted', provider: 'scripted', model: 'scripted-v1' },
      promptVersion: 'prompt-v1',
      graphVersion: 'graph-v1',
      toolVersions: { writer: 'writer-v1' },
      codeRevision: 'memory-reconciliation-test',
    },
  })
  if (!claim) throw new Error('Expected source claim')
  const terminal = await createTerminalRepository(db).completeClaim({
    jobId: job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    exportIdempotencyKey: `job:${job.id}:article:export`,
    topic: 'Private reconciliation source',
    markdown: '# Private reconciliation source\n\nBody.',
    outputPath: null,
  })
  if (!('article' in terminal)) throw new Error('Expected source article')
  return claim.run.id
}

async function uncertainEffect(
  source: { kind: 'run'; runId: string } | { kind: 'signal'; signalId: string },
  providerIdentity?: { requestId: string; responseId: string },
) {
  const extractions = createMemoryExtractionRepository(db)
  const claim = await extractions.claimExtraction({
    source,
    workerId: 'uncertain-memory-worker',
    leaseDurationMs: 30_000,
    maxAttempts: 3,
    execution,
  })
  if (claim.status !== 'claimed') throw new Error('Expected extraction claim')
  const effectKey = 'model:memory-extract:attempt:1'
  const reserved = await extractions.reserveEffect({
    ...claim.identity,
    effectKey,
    requestFingerprint: fingerprintEffectRequest({ source, attempt: 1 }),
    provider: 'scripted',
    model: 'scripted-memory-v1',
    budget: { maximumCostMicrousd: 100, policy: budget },
  })
  if (reserved.status !== 'reserved') throw new Error('Expected effect reservation')
  await extractions.finishEffect({
    ...claim.identity,
    effectKey,
    outcome: 'uncertain',
    metadata: {
      provider: 'scripted',
      model: 'scripted-memory-v1',
      ...(providerIdentity ?? {}),
      latencyMs: 1,
    },
    errorCode: 'provider_outcome_unknown',
    errorMessage: 'Provider outcome cannot be proven.',
  })
  await extractions.failExtraction({
    ...claim.identity,
    outcome: 'uncertain',
    retryable: false,
    maxAttempts: 3,
    errorCode: 'provider_outcome_unknown',
    errorMessage: 'Provider outcome cannot be proven.',
  })
  return { extractions, claim, effect: reserved.effect }
}

function failedResolution(source: { kind: 'run'; runId: string } | { kind: 'signal'; signalId: string }, effectId: string) {
  return {
    source,
    effectId,
    idempotencyKey: `reconcile-${effectId}`,
    decision: 'confirmed_failed' as const,
    retryDisposition: 'requeue' as const,
    maxAttempts: 3,
    evidence: {
      kind: 'provider_lookup' as const,
      fingerprint: `sha256:${'c'.repeat(64)}`,
      providerRequestId: 'provider-request-confirmed-failed',
    },
    reasonCode: 'provider_confirmed_no_result',
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: { microusd: 0, pricingVersion: budget.pricing.version, currency: 'USD' as const },
  }
}

describe('Memory extraction reconciliation governance', () => {
  it('requeues only an owner-confirmed failure and replays the exact decision', async () => {
    const owner = await ownerScope()
    const source = { kind: 'run' as const, runId: await completedRun(owner) }
    const uncertain = await uncertainEffect(source)
    const reconciliations = createMemoryExtractionReconciliationRepository(db)
    const input = failedResolution(source, uncertain.effect.id)

    await expect(reconciliations.getLookupTarget(
      { ...owner, role: 'editor' },
      { source, effectId: uncertain.effect.id },
    )).rejects.toBeInstanceOf(WorkspacePermissionError)
    await expect(reconciliations.getLookupTarget(owner, {
      source,
      effectId: uncertain.effect.id,
    })).resolves.toMatchObject({
      source,
      sourceDeleted: false,
      effectId: uncertain.effect.id,
      provider: 'scripted',
      model: 'scripted-memory-v1',
      providerRequestId: null,
      budget,
    })
    await expect(reconciliations.reconcile({ ...owner, role: 'editor' }, input))
      .rejects.toBeInstanceOf(WorkspacePermissionError)
    await expect(reconciliations.reconcile(owner, input)).resolves.toMatchObject({
      status: 'reconciled',
      replayed: false,
      reconciliation: {
        decision: 'confirmed_failed',
        retryDisposition: 'requeue',
        costMicrousd: 0,
        resolvedByPrincipalId: owner.principalId,
      },
    })
    await expect(reconciliations.reconcile(owner, input)).resolves.toMatchObject({
      status: 'reconciled',
      replayed: true,
    })
    expect(await uncertain.extractions.getExtractionLedger(source)).toMatchObject({
      task: { status: 'queued', attempt: 1 },
      attempts: [{ status: 'failed', errorCode: 'reconciled_provider_failed' }],
      effects: [{ status: 'failed', costMicrousd: 0 }],
    })
    await expect(uncertain.extractions.claimExtraction({
      source,
      workerId: 'reconciled-retry-worker',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })).resolves.toMatchObject({ status: 'claimed', task: { attempt: 2 } })
    await expect(reconciliations.reconcile(owner, {
      ...input,
      reasonCode: 'different_reason',
    })).rejects.toThrow('idempotency collision')
  })

  it('settles confirmed success cost but never retries an unavailable result', async () => {
    const owner = await ownerScope()
    const source = { kind: 'run' as const, runId: await completedRun(owner) }
    const uncertain = await uncertainEffect(source)
    const reconciliations = createMemoryExtractionReconciliationRepository(db)
    await expect(reconciliations.reconcile(owner, {
      source,
      effectId: uncertain.effect.id,
      idempotencyKey: 'reconcile-confirmed-success',
      decision: 'confirmed_succeeded',
      retryDisposition: 'hold',
      evidence: {
        kind: 'billing_export',
        fingerprint: `sha256:${'d'.repeat(64)}`,
        providerRequestId: 'provider-request-confirmed-success',
        providerResponseId: 'provider-response-confirmed-success',
      },
      reasonCode: 'provider_confirmed_success_without_result',
      usage: { inputTokens: 100, outputTokens: 20 },
      cost: { microusd: 2, pricingVersion: budget.pricing.version, currency: 'USD' },
    })).resolves.toMatchObject({
      replayed: false,
      reconciliation: {
        decision: 'confirmed_succeeded',
        providerRequestId: 'provider-request-confirmed-success',
        providerResponseId: 'provider-response-confirmed-success',
        costMicrousd: 2,
      },
    })
    expect(await uncertain.extractions.getExtractionLedger(source)).toMatchObject({
      task: { status: 'failed', errorCode: 'reconciled_result_unavailable' },
      attempts: [{ status: 'failed', errorCode: 'reconciled_result_unavailable' }],
      effects: [{
        status: 'succeeded',
        providerRequestId: 'provider-request-confirmed-success',
        providerResponseId: 'provider-response-confirmed-success',
        costMicrousd: 2,
      }],
    })
    await expect(uncertain.extractions.claimExtraction({
      source,
      workerId: 'forbidden-success-retry',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })).resolves.toMatchObject({ status: 'terminal', taskStatus: 'failed' })
  })

  it('rejects exhausted retry and incomplete or drifted budget evidence without mutation', async () => {
    const owner = await ownerScope()
    const source = { kind: 'run' as const, runId: await completedRun(owner) }
    const uncertain = await uncertainEffect(source)
    const reconciliations = createMemoryExtractionReconciliationRepository(db)
    const succeeded = {
      source,
      effectId: uncertain.effect.id,
      idempotencyKey: 'invalid-success-resolution',
      decision: 'confirmed_succeeded' as const,
      retryDisposition: 'hold' as const,
      evidence: {
        kind: 'provider_lookup' as const,
        fingerprint: `sha256:${'f'.repeat(64)}`,
      },
      reasonCode: 'provider_confirmed_success',
    }
    await expect(reconciliations.reconcile(owner, succeeded))
      .rejects.toThrow('requires usage and cost evidence')
    await expect(reconciliations.reconcile(owner, {
      ...succeeded,
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: { microusd: 1, pricingVersion: 'drifted-pricing', currency: 'USD' },
    })).rejects.toThrow('pricing snapshot collision')
    await expect(reconciliations.reconcile(owner, {
      ...failedResolution(source, uncertain.effect.id),
      idempotencyKey: 'exhausted-retry-resolution',
      maxAttempts: 1,
    })).rejects.toThrow('retry budget is exhausted')
    expect(await uncertain.extractions.getExtractionLedger(source)).toMatchObject({
      task: { status: 'uncertain' },
      attempts: [{ status: 'uncertain' }],
      effects: [{ status: 'uncertain' }],
    })
    expect(await reconciliations.listForSource(owner, source)).toEqual([])
  })

  it('rejects request and response identity drift without creating an audit', async () => {
    const owner = await ownerScope()
    const source = { kind: 'run' as const, runId: await completedRun(owner) }
    const uncertain = await uncertainEffect(source, {
      requestId: 'provider-request-original',
      responseId: 'provider-response-original',
    })
    const reconciliations = createMemoryExtractionReconciliationRepository(db)
    const base = {
      source,
      effectId: uncertain.effect.id,
      decision: 'confirmed_failed' as const,
      retryDisposition: 'hold' as const,
      reasonCode: 'provider_confirmed_failed',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost: { microusd: 0, pricingVersion: budget.pricing.version, currency: 'USD' as const },
    }
    await expect(reconciliations.reconcile(owner, {
      ...base,
      idempotencyKey: 'request-identity-drift',
      evidence: {
        kind: 'provider_lookup' as const,
        fingerprint: `sha256:${'1'.repeat(64)}`,
        providerRequestId: 'provider-request-other',
        providerResponseId: 'provider-response-original',
      },
    })).rejects.toThrow('request identity collision')
    await expect(reconciliations.reconcile(owner, {
      ...base,
      idempotencyKey: 'response-identity-drift',
      evidence: {
        kind: 'provider_lookup' as const,
        fingerprint: `sha256:${'2'.repeat(64)}`,
        providerRequestId: 'provider-request-original',
        providerResponseId: 'provider-response-other',
      },
    })).rejects.toThrow('response identity collision')
    expect(await reconciliations.listForSource(owner, source)).toEqual([])
  })

  it('can settle but cannot requeue an erased signal source', async () => {
    const owner = await ownerScope()
    const signals = createMemorySourceSignalRepository(db)
    const created = await signals.create(owner, {
      idempotencyKey: 'reconciliation-erased-signal',
      sourceKind: 'explicit_remember',
      subject: { kind: 'principal', key: owner.principalId },
      text: 'Remember this only while the source exists.',
      consentPolicyVersion: 'memory-consent-v1',
      retentionDays: 30,
    })
    const source = { kind: 'signal' as const, signalId: created.signal.id }
    const uncertain = await uncertainEffect(source)
    await signals.delete(owner, {
      sourceSignalId: created.signal.id,
      reasonCode: 'user_erased_before_reconciliation',
    })
    const reconciliations = createMemoryExtractionReconciliationRepository(db)
    const input = failedResolution(source, uncertain.effect.id)
    await expect(reconciliations.reconcile(owner, input))
      .rejects.toThrow('Erased Memory source cannot be requeued')
    await expect(reconciliations.reconcile(owner, {
      ...input,
      retryDisposition: 'hold',
      maxAttempts: undefined,
    })).resolves.toMatchObject({ replayed: false })
    expect(await reconciliations.listForSource(owner, source)).toHaveLength(1)
  })
})
