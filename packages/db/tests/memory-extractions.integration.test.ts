import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import {
  createJobRepository,
  createMemoryExtractionRepository,
  createTerminalRepository,
  fingerprintEffectRequest,
  SYSTEM_PRINCIPAL_ID,
  SYSTEM_WORKSPACE_ID,
  type MemoryExtractionExecutionSnapshot,
} from '../src'
import * as schema from '../src/schema'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
let client: PGlite
let db: ReturnType<typeof drizzle<typeof schema>>

const execution: MemoryExtractionExecutionSnapshot = {
  extractorKey: 'completed-article-memory',
  extractorVersion: 'v1',
  promptVersion: 'memory-extractor-v1',
  consentPolicyVersion: 'workspace-memory-v1',
  retentionDays: 30,
  modelProfile: {
    profile: 'scripted-memory',
    provider: 'scripted',
    model: 'scripted-memory-v1',
  },
}

const budgetPolicy = {
  policyVersion: 'memory-budget-v1',
  maxSourceCostMicrousd: 100,
  maxWorkspaceDailyCostMicrousd: 100,
  maxOutputTokens: 256,
  pricing: {
    version: 'memory-pricing-v1',
    inputMicrousdPerMillionTokens: 1_000,
    outputMicrousdPerMillionTokens: 2_000,
    cacheReadMicrousdPerMillionTokens: 100,
    cacheWriteMicrousdPerMillionTokens: 1_250,
  },
}

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      memory_extraction_effects, memory_extraction_attempts, memory_extraction_tasks,
      memory_tombstones, memory_candidate_events, memory_revisions, memories,
      memory_candidates, article_versions, articles, job_commands, job_interrupts,
      checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function completedRun() {
  const jobs = createJobRepository(db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: `memory-ledger-${randomUUID()}`,
    topic: 'Private source topic',
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: 'memory-ledger-source',
    leaseDurationMs: 30_000,
    execution: {
      modelProfile: { profile: 'scripted', provider: 'scripted', model: 'scripted-v1' },
      promptVersion: 'prompt-v1',
      graphVersion: 'graph-v1',
      toolVersions: { writer: 'writer-v1' },
      codeRevision: 'memory-ledger-test',
    },
  })
  if (!claim) throw new Error('Expected source claim')
  const terminal = await createTerminalRepository(db).completeClaim({
    jobId: job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    exportIdempotencyKey: `job:${job.id}:article:export`,
    topic: 'Private source topic',
    markdown: '# Private article\n\nPrefer concise technical prose.',
    outputPath: null,
  })
  if (!('article' in terminal)) throw new Error('Expected completed article')
  return claim.run.id
}

function requestFingerprint(runId: string, attempt: number) {
  return fingerprintEffectRequest({
    sourceRunId: runId,
    attempt,
    evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
    promptVersion: execution.promptVersion,
  })
}

describe('Memory extraction attempt and provider effect ledger', () => {
  it('claims, fences, meters, completes, and replays without a second provider reservation', async () => {
    const sourceRunId = await completedRun()
    const repository = createMemoryExtractionRepository(db)
    const claim = await repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-1',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })
    expect(claim).toMatchObject({
      status: 'claimed',
      task: { status: 'running', attempt: 1, executionSnapshot: execution },
      attempt: { status: 'running', attempt: 1, workerId: 'memory-worker-1' },
    })
    if (claim.status !== 'claimed') throw new Error('Expected Memory extraction claim')

    await expect(repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-2',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })).resolves.toEqual({ status: 'busy' })

    const effect = {
      ...claim.identity,
      effectKey: 'model:extract:attempt:1',
      requestFingerprint: requestFingerprint(sourceRunId, 1),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    }
    await expect(repository.reserveEffect(effect)).resolves.toMatchObject({ status: 'reserved' })
    await expect(repository.reserveEffect(effect)).resolves.toEqual({ status: 'already_reserved' })

    const finished = {
      ...claim.identity,
      effectKey: effect.effectKey,
      outcome: 'succeeded' as const,
      metadata: {
        provider: 'scripted',
        model: 'scripted-memory-v1',
        requestId: 'memory-request-1',
        usage: { inputTokens: 120, outputTokens: 24, cacheReadInputTokens: 20 },
        cost: { microusd: 420, pricingVersion: 'test-pricing-v1', currency: 'USD' as const },
        latencyMs: 15,
      },
    }
    await expect(repository.finishEffect(finished)).resolves.toMatchObject({
      status: 'finished',
      effect: {
        status: 'succeeded',
        providerRequestId: 'memory-request-1',
        inputTokens: 120,
        outputTokens: 24,
        costMicrousd: 420,
      },
    })
    await expect(repository.finishEffect(finished)).resolves.toMatchObject({ status: 'replayed' })

    const counts = {
      proposalCount: 2,
      candidateCount: 1,
      conflictCount: 0,
      duplicateCount: 0,
      rejectedCount: 1,
      createdCount: 1,
      existingCount: 0,
    }
    await expect(repository.completeExtraction(claim.identity, counts)).resolves.toMatchObject({
      status: 'completed',
      task: { status: 'completed', resultMetadata: counts },
    })
    await expect(repository.heartbeatExtraction(claim.identity, 30_000)).resolves.toBe('lease_lost')
    await expect(repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-replay',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })).resolves.toEqual({
      status: 'terminal',
      taskStatus: 'completed',
      resultMetadata: counts,
    })

    const ledger = await repository.getExtractionLedger({ kind: 'run', runId: sourceRunId })
    expect(ledger).toMatchObject({
      task: { status: 'completed', attempt: 1 },
      attempts: [{ status: 'completed', attempt: 1 }],
      effects: [{ status: 'succeeded', provider: 'scripted', model: 'scripted-memory-v1' }],
    })
    expect(JSON.stringify(ledger)).not.toContain('Private source topic')
    expect(JSON.stringify(ledger)).not.toContain('concise technical prose')
  })

  it('allows a new attempt only after a known failed effect and freezes its execution snapshot', async () => {
    const sourceRunId = await completedRun()
    const repository = createMemoryExtractionRepository(db)
    const first = await repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-1',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })
    if (first.status !== 'claimed') throw new Error('Expected first claim')
    const effect = {
      ...first.identity,
      effectKey: 'model:extract:attempt:1',
      requestFingerprint: requestFingerprint(sourceRunId, 1),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    }
    await repository.reserveEffect(effect)
    await repository.finishEffect({
      ...first.identity,
      effectKey: effect.effectKey,
      outcome: 'failed',
      metadata: { provider: 'scripted', model: 'scripted-memory-v1', latencyMs: 4 },
      errorCode: 'rate_limited',
      errorMessage: 'Provider request was rate limited.',
    })
    await expect(repository.failExtraction({
      ...first.identity,
      outcome: 'failed',
      retryable: true,
      maxAttempts: 3,
      errorCode: 'rate_limited',
      errorMessage: 'Provider request was rate limited.',
    })).resolves.toMatchObject({ status: 'retry_queued', task: { status: 'queued' } })

    await expect(repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-drifted',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: { ...execution, promptVersion: 'memory-extractor-v2' },
    })).rejects.toThrow('execution snapshot collision')

    const second = await repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-2',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })
    expect(second).toMatchObject({
      status: 'claimed',
      task: { attempt: 2 },
      attempt: { attempt: 2, status: 'running' },
    })
    const ledger = await repository.getExtractionLedger({ kind: 'run', runId: sourceRunId })
    expect(ledger?.attempts).toMatchObject([
      { attempt: 1, status: 'failed', errorCode: 'rate_limited' },
      { attempt: 2, status: 'running' },
    ])
  })

  it('marks an expired reserved effect uncertain and never issues a takeover claim', async () => {
    const sourceRunId = await completedRun()
    const repository = createMemoryExtractionRepository(db)
    const claim = await repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-crash',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })
    if (claim.status !== 'claimed') throw new Error('Expected claim')
    await repository.reserveEffect({
      ...claim.identity,
      effectKey: 'model:extract:attempt:1',
      requestFingerprint: requestFingerprint(sourceRunId, 1),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    })
    await db.update(schema.memoryExtractionTasks).set({
      leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })

    await expect(repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-takeover',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })).resolves.toEqual({
      status: 'terminal',
      taskStatus: 'uncertain',
      resultMetadata: null,
    })
    expect(await repository.getExtractionLedger({ kind: 'run', runId: sourceRunId }))
      .toMatchObject({
      task: { status: 'uncertain', attempt: 1 },
      attempts: [{ status: 'uncertain', errorCode: 'lease_expired_after_provider_reservation' }],
      effects: [{ status: 'uncertain', errorCode: 'lease_expired_after_provider_reservation' }],
    })
  })

  it('forces reconciliation when downstream persistence fails after a succeeded provider effect', async () => {
    const sourceRunId = await completedRun()
    const repository = createMemoryExtractionRepository(db)
    const claim = await repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-downstream',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })
    if (claim.status !== 'claimed') throw new Error('Expected claim')
    const effectKey = 'model:extract:attempt:1'
    await repository.reserveEffect({
      ...claim.identity,
      effectKey,
      requestFingerprint: requestFingerprint(sourceRunId, 1),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    })
    await repository.finishEffect({
      ...claim.identity,
      effectKey,
      outcome: 'succeeded',
      metadata: { provider: 'scripted', model: 'scripted-memory-v1', latencyMs: 3 },
    })
    await expect(repository.failExtraction({
      ...claim.identity,
      outcome: 'failed',
      retryable: true,
      maxAttempts: 3,
      errorCode: 'candidate_write_failed',
      errorMessage: 'Candidate submission failed.',
    })).resolves.toMatchObject({
      status: 'uncertain',
      task: { status: 'uncertain', errorCode: 'provider_effect_uncertain' },
    })
    await expect(repository.claimExtraction({
      source: { kind: 'run', runId: sourceRunId },
      workerId: 'memory-worker-forbidden-replay',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution,
    })).resolves.toMatchObject({ status: 'terminal', taskStatus: 'uncertain' })
  })

  it('serializes workspace budget reservations and releases only known failed cost', async () => {
    const firstRunId = await completedRun()
    const secondRunId = await completedRun()
    const thirdRunId = await completedRun()
    const fourthRunId = await completedRun()
    const repository = createMemoryExtractionRepository(db)
    const claim = async (runId: string, workerId: string) => {
      const result = await repository.claimExtraction({
        source: { kind: 'run', runId },
        workerId,
        leaseDurationMs: 30_000,
        maxAttempts: 3,
        execution: { ...execution, budget: budgetPolicy },
      })
      if (result.status !== 'claimed') throw new Error('Expected budgeted claim')
      return result
    }
    const effect = (
      runId: string,
      claimed: { identity: { sourceId: string; attemptId: string; leaseToken: string } },
      policy = budgetPolicy,
    ) => ({
      ...claimed.identity,
      effectKey: 'model:extract:attempt:1',
      requestFingerprint: requestFingerprint(runId, 1),
      provider: 'scripted',
      model: 'scripted-memory-v1',
      budget: { maximumCostMicrousd: 60, policy },
    })

    const first = await claim(firstRunId, 'budget-worker-1')
    await expect(repository.reserveEffect(effect(firstRunId, first))).resolves.toMatchObject({
      status: 'reserved',
      effect: {
        reservedCostMicrousd: 60,
        sourceBudgetMicrousd: 100,
        workspaceDailyBudgetMicrousd: 100,
        budgetPolicyVersion: 'memory-budget-v1',
        reservationPricingVersion: 'memory-pricing-v1',
      },
    })

    const second = await claim(secondRunId, 'budget-worker-2')
    await expect(repository.reserveEffect(effect(secondRunId, second))).resolves.toEqual({
      status: 'budget_rejected',
      reason: 'workspace_daily_limit',
    })

    await repository.finishEffect({
      ...first.identity,
      effectKey: 'model:extract:attempt:1',
      outcome: 'failed',
      metadata: { provider: 'scripted', model: 'scripted-memory-v1', latencyMs: 1 },
      errorCode: 'known_failed',
      errorMessage: 'Provider rejected before billable completion.',
    })
    await expect(repository.reserveEffect(effect(secondRunId, second))).resolves.toMatchObject({
      status: 'reserved',
    })

    const third = await claim(thirdRunId, 'budget-worker-3')
    await expect(repository.reserveEffect(effect(thirdRunId, third, {
      ...budgetPolicy,
      pricing: {
        ...budgetPolicy.pricing,
        inputMicrousdPerMillionTokens:
          budgetPolicy.pricing.inputMicrousdPerMillionTokens + 1,
      },
    }))).rejects.toThrow('budget does not match execution snapshot')

    const fourth = await repository.claimExtraction({
      source: { kind: 'run', runId: fourthRunId },
      workerId: 'budget-worker-4',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: {
        ...execution,
        budget: {
          ...budgetPolicy,
          policyVersion: 'memory-budget-v2',
        },
      },
    })
    if (fourth.status !== 'claimed') throw new Error('Expected drifted budget claim')
    await expect(repository.reserveEffect(effect(fourthRunId, fourth, {
      ...budgetPolicy,
      policyVersion: 'memory-budget-v2',
    }))).resolves.toEqual({
      status: 'budget_rejected',
      reason: 'workspace_policy_drift',
    })
    await repository.finishEffect({
      ...second.identity,
      effectKey: 'model:extract:attempt:1',
      outcome: 'uncertain',
      metadata: { provider: 'scripted', model: 'scripted-memory-v1', latencyMs: 1 },
      errorCode: 'provider_outcome_unknown',
      errorMessage: 'Provider outcome cannot be proven.',
    })
    await expect(repository.reserveEffect(effect(thirdRunId, third))).resolves.toEqual({
      status: 'budget_rejected',
      reason: 'workspace_daily_limit',
    })
  })
})
