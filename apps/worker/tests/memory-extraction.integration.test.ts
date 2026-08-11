import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import {
  createJobRepository,
  createMemoryExtractionRepository,
  createMemoryExtractionReconciliationRepository,
  createMemorySourceSignalRepository,
  createOutboxRepository,
  createTerminalRepository,
  createWorkspaceRepository,
  fingerprintEffectRequest,
  SYSTEM_PRINCIPAL_ID,
  SYSTEM_WORKSPACE_ID,
} from '@vibe-writer/db'
import * as schema from '@vibe-writer/db/schema'
import { ScriptedProviderRequestLookup } from '@vibe-writer/provider-runtime'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MEMORY_EXTRACTION_QUEUE_JOB_NAME,
  MemoryExtractionProviderError,
  MemoryExtractionReconciliationService,
  MemoryExtractionService,
  MemoryExtractionTerminalError,
  MemoryOutboxDispatcher,
  UnrecoverableQueueMessageError,
  processMemoryExtractionQueueJob,
  type MemoryExtractionPublisher,
} from '../src'

const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
)
let client: PGlite
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      memory_extraction_effects, memory_extraction_attempts, memory_extraction_tasks,
      memory_source_signal_tombstones, memory_source_signals,
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
    idempotencyKey: `memory-extraction-${randomUUID()}`,
    topic: 'Private source topic',
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: 'memory-extraction-source',
    leaseDurationMs: 30_000,
    execution: {
      modelProfile: { profile: 'scripted', provider: 'scripted', model: 'scripted-v1' },
      promptVersion: 'prompt-v1',
      graphVersion: 'graph-v1',
      toolVersions: { writer: 'writer-v1' },
      codeRevision: 'memory-extraction-test',
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
    requestMemoryExtraction: true,
  })
  if (!('article' in terminal)) throw new Error('Expected completed article')
  return { job, run: claim.run }
}

describe('scripted durable Memory extraction delivery', () => {
  it('moves a pointer through outbox and creates review candidates idempotently', async () => {
    const source = await completedRun()
    const outbox = createOutboxRepository(db)
    const published: Array<{
      name: string
      data: { schemaVersion: 2; source: { kind: 'run'; runId: string } }
      options: { jobId: string }
    }> = []
    const publisher: MemoryExtractionPublisher = {
      enqueue: vi.fn(async (name, data, options) => {
        published.push({ name, data, options })
      }),
    }
    const dispatcher = new MemoryOutboxDispatcher(outbox, publisher, {
      dispatcherId: 'memory-dispatcher-test',
      batchSize: 10,
      lockTimeoutMs: 30_000,
      maxAttempts: 3,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      now: () => new Date('2026-08-07T00:00:00.000Z'),
    })
    await expect(dispatcher.dispatchBatch()).resolves.toMatchObject([{
      status: 'published',
      queueJobId: `memory-run-${source.run.id}`,
    }])
    expect(published).toEqual([{
      name: MEMORY_EXTRACTION_QUEUE_JOB_NAME,
      data: { schemaVersion: 2, source: { kind: 'run', runId: source.run.id } },
      options: { jobId: `memory-run-${source.run.id}` },
    }])
    expect(JSON.stringify(published)).not.toContain('Private article')
    expect(JSON.stringify(published)).not.toContain('concise technical')

    const extractor = {
      extract: vi.fn(async () => ({
        provider: 'scripted',
        model: 'scripted-memory-v1',
        requestId: 'scripted-memory-request-1',
        responseId: 'scripted-memory-response-1',
        usage: { inputTokens: 120, outputTokens: 24 },
        output: {
          schemaVersion: 1 as const,
          candidates: [
            {
              subject: { kind: 'workspace' as const, key: 'default' },
              memoryKey: 'writing.tone',
              kind: 'preference' as const,
              content: 'Prefer concise technical prose.',
              confidence: 0.95,
              sensitivity: 'normal' as const,
            },
            {
              subject: { kind: 'workspace' as const, key: 'default' },
              memoryKey: 'identity.sensitive-inference',
              kind: 'correction' as const,
              content: 'A sensitive model inference.',
              confidence: 0.99,
              sensitivity: 'sensitive' as const,
            },
          ],
        },
      })),
    }
    const service = new MemoryExtractionService(
      createMemoryExtractionRepository(db),
      extractor,
      {
        extractorKey: 'scripted-completed-article',
        extractorVersion: 'v1',
        promptVersion: 'memory-extractor-v1',
        consentPolicyVersion: 'workspace-memory-v1',
        retentionDays: 30,
        modelProfile: {
          profile: 'scripted-memory',
          provider: 'scripted',
          model: 'scripted-memory-v1',
        },
        workerId: 'memory-extraction-integration-worker',
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        maxAttempts: 3,
      },
    )
    const delivery = published[0]!
    await expect(processMemoryExtractionQueueJob({
      name: delivery.name,
      data: delivery.data,
    }, service)).resolves.toEqual({
      status: 'completed',
      source: { kind: 'run', runId: source.run.id },
      proposalCount: 2,
      candidateCount: 1,
      conflictCount: 0,
      duplicateCount: 0,
      rejectedCount: 1,
      createdCount: 1,
      existingCount: 0,
    })
    await expect(processMemoryExtractionQueueJob({
      name: delivery.name,
      data: delivery.data,
    }, service)).resolves.toMatchObject({
      status: 'completed',
      candidateCount: 1,
      rejectedCount: 1,
      createdCount: 1,
      existingCount: 0,
    })
    expect(extractor.extract).toHaveBeenCalledWith({
      promptInput: {
        segments: [
          { id: 'job-topic', author: 'user', scope: 'task', text: 'Private source topic' },
          {
            id: 'generated-article',
            author: 'assistant',
            scope: 'task',
            text: '# Private article\n\nPrefer concise technical prose.',
          },
        ],
      },
      signal: expect.any(AbortSignal),
    })
    expect(extractor.extract).toHaveBeenCalledTimes(1)
    expect(await db.select().from(schema.memoryExtractionTasks)).toMatchObject([{
      sourceRunId: source.run.id,
      status: 'completed',
      attempt: 1,
    }])
    expect(await db.select().from(schema.memoryExtractionEffects)).toMatchObject([{
      sourceId: source.run.id,
      status: 'succeeded',
      provider: 'scripted',
      model: 'scripted-memory-v1',
      providerRequestId: 'scripted-memory-request-1',
      providerResponseId: 'scripted-memory-response-1',
      inputTokens: 120,
      outputTokens: 24,
    }])
    expect(await db.select().from(schema.memoryCandidates)).toMatchObject([{
      sourceRunId: source.run.id,
      workspaceId: SYSTEM_WORKSPACE_ID,
      memoryKey: 'writing.tone',
      status: 'pending_review',
      proposedBy: 'model',
    }])
    expect(await db.select().from(schema.memories)).toEqual([])
  })

  it('rejects malformed queue envelopes without reading source content', async () => {
    const service = { run: vi.fn() }
    await expect(processMemoryExtractionQueueJob({
      name: MEMORY_EXTRACTION_QUEUE_JOB_NAME,
      data: { schemaVersion: 1, runId: 'not-a-uuid', content: 'must not be accepted' },
    }, service)).rejects.toBeInstanceOf(UnrecoverableQueueMessageError)
    expect(service.run).not.toHaveBeenCalled()
  })

  it('upgrades an exact legacy run envelope to the typed source contract', async () => {
    const runId = randomUUID()
    const service = {
      run: vi.fn(async (source: { kind: 'run'; runId: string }) => ({
        status: 'not_found' as const,
        source,
      })),
    }
    await expect(processMemoryExtractionQueueJob({
      name: MEMORY_EXTRACTION_QUEUE_JOB_NAME,
      data: { schemaVersion: 1, runId },
    }, service)).resolves.toEqual({
      status: 'not_found',
      source: { kind: 'run', runId },
    })
    expect(service.run).toHaveBeenCalledWith({ kind: 'run', runId })
  })

  it('rejects an insufficient hard budget before invoking the provider', async () => {
    const source = await completedRun()
    const extractor = {
      maxOutputTokens: 1,
      extract: vi.fn(),
    }
    const repository = createMemoryExtractionRepository(db)
    const service = new MemoryExtractionService(repository, extractor, {
      extractorKey: 'budget-rejection-extractor',
      extractorVersion: 'v1',
      promptVersion: '2026-08-07-v1',
      consentPolicyVersion: 'workspace-memory-v1',
      retentionDays: 30,
      modelProfile: {
        profile: 'scripted-memory',
        provider: 'scripted',
        model: 'scripted-memory-v1',
      },
      workerId: 'budget-rejection-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
      budget: {
        policyVersion: 'memory-budget-v1',
        maxSourceCostMicrousd: 1,
        maxWorkspaceDailyCostMicrousd: 10,
        maxOutputTokens: 1,
        pricing: {
          version: 'scripted-pricing-v1',
          inputMicrousdPerMillionTokens: 1_000_000,
          outputMicrousdPerMillionTokens: 1_000_000,
          cacheReadMicrousdPerMillionTokens: 0,
          cacheWriteMicrousdPerMillionTokens: 0,
        },
      },
    })

    await expect(service.run({ kind: 'run', runId: source.run.id })).rejects.toMatchObject({
      code: 'budget_source_limit',
    })
    expect(extractor.extract).not.toHaveBeenCalled()
    expect(await repository.getExtractionLedger({ kind: 'run', runId: source.run.id }))
      .toMatchObject({
        task: { status: 'failed', errorCode: 'budget_source_limit' },
        attempts: [{ status: 'failed', errorCode: 'budget_source_limit' }],
        effects: [],
      })
  })

  it('rejects extractor max-token drift before claiming a source', () => {
    expect(() => new MemoryExtractionService(
      createMemoryExtractionRepository(db),
      { maxOutputTokens: 2, extract: vi.fn() },
      {
        extractorKey: 'drifted-budget-extractor',
        extractorVersion: 'v1',
        promptVersion: '2026-08-07-v1',
        consentPolicyVersion: 'workspace-memory-v1',
        retentionDays: 30,
        modelProfile: {
          profile: 'scripted-memory',
          provider: 'scripted',
          model: 'scripted-memory-v1',
        },
        workerId: 'drifted-budget-worker',
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        maxAttempts: 3,
        budget: {
          policyVersion: 'memory-budget-v1',
          maxSourceCostMicrousd: 10,
          maxWorkspaceDailyCostMicrousd: 100,
          maxOutputTokens: 1,
          pricing: {
            version: 'scripted-pricing-v1',
            inputMicrousdPerMillionTokens: 1,
            outputMicrousdPerMillionTokens: 1,
            cacheReadMicrousdPerMillionTokens: 0,
            cacheWriteMicrousdPerMillionTokens: 0,
          },
        },
      },
    )).toThrow('maxOutputTokens must match')
  })

  it('settles successful provider usage against the immutable pricing snapshot', async () => {
    const source = await completedRun()
    const extractor = {
      maxOutputTokens: 256,
      extract: vi.fn(async () => ({
        provider: 'scripted',
        model: 'scripted-memory-v1',
        requestId: 'budgeted-request-1',
        usage: { inputTokens: 100, outputTokens: 20 },
        output: { schemaVersion: 1 as const, candidates: [] },
      })),
    }
    const repository = createMemoryExtractionRepository(db)
    const service = new MemoryExtractionService(repository, extractor, {
      extractorKey: 'budgeted-extractor',
      extractorVersion: 'v1',
      promptVersion: '2026-08-07-v1',
      consentPolicyVersion: 'workspace-memory-v1',
      retentionDays: 30,
      modelProfile: {
        profile: 'scripted-memory',
        provider: 'scripted',
        model: 'scripted-memory-v1',
      },
      workerId: 'budgeted-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
      budget: {
        policyVersion: 'memory-budget-v1',
        maxSourceCostMicrousd: 10_000,
        maxWorkspaceDailyCostMicrousd: 100_000,
        maxOutputTokens: 256,
        pricing: {
          version: 'scripted-pricing-v1',
          inputMicrousdPerMillionTokens: 10_000,
          outputMicrousdPerMillionTokens: 20_000,
          cacheReadMicrousdPerMillionTokens: 1_000,
          cacheWriteMicrousdPerMillionTokens: 12_500,
        },
      },
    })

    await expect(service.run({ kind: 'run', runId: source.run.id })).resolves.toMatchObject({
      status: 'completed',
      candidateCount: 0,
    })
    expect(await repository.getExtractionLedger({ kind: 'run', runId: source.run.id }))
      .toMatchObject({
        effects: [{
          status: 'succeeded',
          costMicrousd: 2,
          pricingVersion: 'scripted-pricing-v1',
          costCurrency: 'USD',
          reservedCostMicrousd: expect.any(Number),
        }],
      })
  })

  it('keeps the reservation uncertain when a budgeted response omits usage', async () => {
    const source = await completedRun()
    const extractor = {
      maxOutputTokens: 64,
      extract: vi.fn(async () => ({
        provider: 'scripted',
        model: 'scripted-memory-v1',
        requestId: 'unmetered-request-1',
        output: { schemaVersion: 1 as const, candidates: [] },
      })),
    }
    const repository = createMemoryExtractionRepository(db)
    const service = new MemoryExtractionService(repository, extractor, {
      extractorKey: 'unmetered-budget-extractor',
      extractorVersion: 'v1',
      promptVersion: '2026-08-07-v1',
      consentPolicyVersion: 'workspace-memory-v1',
      retentionDays: 30,
      modelProfile: {
        profile: 'scripted-memory',
        provider: 'scripted',
        model: 'scripted-memory-v1',
      },
      workerId: 'unmetered-budget-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
      budget: {
        policyVersion: 'memory-budget-v1',
        maxSourceCostMicrousd: 10_000,
        maxWorkspaceDailyCostMicrousd: 100_000,
        maxOutputTokens: 64,
        pricing: {
          version: 'scripted-pricing-v1',
          inputMicrousdPerMillionTokens: 10_000,
          outputMicrousdPerMillionTokens: 20_000,
          cacheReadMicrousdPerMillionTokens: 1_000,
          cacheWriteMicrousdPerMillionTokens: 12_500,
        },
      },
    })

    await expect(service.run({ kind: 'run', runId: source.run.id })).rejects.toMatchObject({
      code: 'budget_usage_missing',
    })
    expect(await repository.getExtractionLedger({ kind: 'run', runId: source.run.id }))
      .toMatchObject({
        task: { status: 'uncertain', errorCode: 'budget_usage_missing' },
        attempts: [{ status: 'uncertain', errorCode: 'budget_usage_missing' }],
        effects: [{
          status: 'uncertain',
          errorCode: 'budget_usage_missing',
          reservedCostMicrousd: expect.any(Number),
          costMicrousd: null,
        }],
      })
  })

  it('delivers a durable user signal with trusted subject and retains a detached completed ledger', async () => {
    const owner = await createWorkspaceRepository(db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `worker-signal-${randomUUID().slice(0, 8)}`,
      name: 'Worker signal extraction',
    })
    const signals = createMemorySourceSignalRepository(db)
    const created = await signals.create(owner, {
      idempotencyKey: 'worker-signal-delivery',
      sourceKind: 'explicit_remember',
      subject: { kind: 'principal', key: owner.principalId },
      text: '以后写技术内容时请保持简洁直接。',
      consentPolicyVersion: 'memory-consent-v1',
      retentionDays: 30,
    })
    const published: Array<{
      name: string
      data: { schemaVersion: 2; source: { kind: 'signal'; signalId: string } }
      options: { jobId: string }
    }> = []
    const dispatcher = new MemoryOutboxDispatcher(
      createOutboxRepository(db),
      {
        enqueue: vi.fn(async (name, data, options) => {
          if (data.source.kind !== 'signal') throw new Error('Expected signal source')
          published.push({ name, data: { ...data, source: data.source }, options })
        }),
      },
      {
        dispatcherId: 'signal-memory-dispatcher',
        batchSize: 10,
        lockTimeoutMs: 30_000,
        maxAttempts: 3,
        initialBackoffMs: 1_000,
        maxBackoffMs: 30_000,
      },
    )
    await expect(dispatcher.dispatchBatch()).resolves.toMatchObject([{
      status: 'published',
      queueJobId: `memory-signal-${created.signal.id}`,
    }])
    expect(published).toEqual([{
      name: MEMORY_EXTRACTION_QUEUE_JOB_NAME,
      data: {
        schemaVersion: 2,
        source: { kind: 'signal', signalId: created.signal.id },
      },
      options: { jobId: `memory-signal-${created.signal.id}` },
    }])

    const extractor = {
      extract: vi.fn(async () => ({
        provider: 'scripted',
        model: 'scripted-memory-v1',
        requestId: 'signal-request-1',
        output: {
          schemaVersion: 1 as const,
          candidates: [{
            subject: { kind: 'workspace' as const, key: 'model-forged-subject' },
            memoryKey: 'writing.tone',
            kind: 'preference' as const,
            content: 'Prefer concise and direct technical prose.',
            confidence: 0.95,
            sensitivity: 'normal' as const,
          }],
        },
      })),
    }
    const repository = createMemoryExtractionRepository(db)
    const service = new MemoryExtractionService(repository, extractor, {
      extractorKey: 'signal-memory-extractor',
      extractorVersion: 'v1',
      promptVersion: 'memory-extractor-v1',
      consentPolicyVersion: 'unused-for-signal',
      retentionDays: 30,
      modelProfile: {
        profile: 'scripted-signal-memory',
        provider: 'scripted',
        model: 'scripted-memory-v1',
      },
      workerId: 'signal-memory-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
    })
    const delivery = published[0]!
    await expect(processMemoryExtractionQueueJob({
      name: delivery.name,
      data: delivery.data,
    }, service)).resolves.toMatchObject({
      status: 'completed',
      source: { kind: 'signal', signalId: created.signal.id },
      candidateCount: 1,
      createdCount: 1,
    })
    expect(extractor.extract).toHaveBeenCalledWith({
      promptInput: {
        segments: [{
          id: 'memory-signal',
          author: 'user',
          scope: 'durable',
          text: '以后写技术内容时请保持简洁直接。',
        }],
      },
      signal: expect.any(AbortSignal),
    })
    expect(await db.select().from(schema.memoryCandidates)).toMatchObject([{
      sourceKind: 'signal',
      sourceSignalId: created.signal.id,
      subjectKind: 'principal',
      subjectKey: owner.principalId,
      consentBasis: 'explicit_user',
    }])

    await signals.delete(owner, {
      sourceSignalId: created.signal.id,
      reasonCode: 'user_revoked_after_extraction',
    })
    expect(await db.select().from(schema.memoryCandidates)).toEqual([])
    expect(await repository.getExtractionLedger({
      kind: 'signal', signalId: created.signal.id,
    })).toMatchObject({
      task: {
        status: 'completed',
        sourceSignalId: null,
        sourceDeletedAt: expect.any(Date),
      },
      attempts: [{ status: 'completed' }],
      effects: [{ status: 'succeeded', providerRequestId: 'signal-request-1' }],
    })
  })

  it('retries only a provider-declared failed outcome under a new durable attempt', async () => {
    const source = await completedRun()
    const extractor = {
      extract: vi.fn()
        .mockRejectedValueOnce(new MemoryExtractionProviderError(
          'rate_limited',
          'private provider response',
          { outcome: 'failed', retryable: true },
        ))
        .mockResolvedValueOnce({
          provider: 'scripted',
          model: 'scripted-memory-v1',
          requestId: 'memory-request-after-retry',
          output: {
            schemaVersion: 1 as const,
            candidates: [{
              subject: { kind: 'workspace' as const, key: 'default' },
              memoryKey: 'writing.format',
              kind: 'preference' as const,
              content: 'Use short sections.',
              confidence: 0.9,
              sensitivity: 'normal' as const,
            }],
          },
        }),
    }
    const repository = createMemoryExtractionRepository(db)
    const service = new MemoryExtractionService(repository, extractor, {
      extractorKey: 'scripted-retry-extractor',
      extractorVersion: 'v1',
      promptVersion: 'memory-extractor-v1',
      consentPolicyVersion: 'workspace-memory-v1',
      retentionDays: 30,
      modelProfile: {
        profile: 'scripted-memory',
        provider: 'scripted',
        model: 'scripted-memory-v1',
      },
      workerId: 'memory-retry-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
    })

    const sourcePointer = { kind: 'run' as const, runId: source.run.id }
    await expect(service.run(sourcePointer)).rejects.toMatchObject({
      code: 'rate_limited',
    })
    await expect(service.run(sourcePointer)).resolves.toMatchObject({
      status: 'completed',
      createdCount: 1,
    })
    expect(extractor.extract).toHaveBeenCalledTimes(2)
    const ledger = await repository.getExtractionLedger(sourcePointer)
    expect(ledger?.attempts).toMatchObject([
      { attempt: 1, status: 'failed', errorCode: 'rate_limited' },
      { attempt: 2, status: 'completed' },
    ])
    expect(ledger?.effects).toMatchObject([
      { effectKey: 'model:memory-extract:attempt:1', status: 'failed' },
      { effectKey: 'model:memory-extract:attempt:2', status: 'succeeded' },
    ])
    expect(JSON.stringify(ledger)).not.toContain('private provider response')
  })

  it('fails closed on an unknown provider outcome and does not call the provider again', async () => {
    const source = await completedRun()
    const repository = createMemoryExtractionRepository(db)
    const extractor = {
      extract: vi.fn(async () => {
        throw new Error('private timeout details')
      }),
    }
    const service = new MemoryExtractionService(repository, extractor, {
      extractorKey: 'scripted-uncertain-extractor',
      extractorVersion: 'v1',
      promptVersion: 'memory-extractor-v1',
      consentPolicyVersion: 'workspace-memory-v1',
      retentionDays: 30,
      modelProfile: {
        profile: 'scripted-memory',
        provider: 'scripted',
        model: 'scripted-memory-v1',
      },
      workerId: 'memory-uncertain-worker',
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      maxAttempts: 3,
    })

    const sourcePointer = { kind: 'run' as const, runId: source.run.id }
    await expect(service.run(sourcePointer)).rejects.toBeInstanceOf(
      MemoryExtractionTerminalError,
    )
    await expect(service.run(sourcePointer)).resolves.toEqual({
      status: 'terminal',
      source: sourcePointer,
      taskStatus: 'uncertain',
    })
    expect(extractor.extract).toHaveBeenCalledTimes(1)
    const ledger = await repository.getExtractionLedger(sourcePointer)
    expect(ledger).toMatchObject({
      task: { status: 'uncertain', errorCode: 'provider_outcome_unknown' },
      attempts: [{ status: 'uncertain', errorCode: 'provider_outcome_unknown' }],
      effects: [{ status: 'uncertain', errorCode: 'provider_outcome_unknown' }],
    })
    expect(JSON.stringify(ledger)).not.toContain('private timeout details')
  })

  it('resolves a provider-confirmed result through the real ledger without replaying the model', async () => {
    const completed = await completedRun()
    const source = { kind: 'run' as const, runId: completed.run.id }
    const repository = createMemoryExtractionRepository(db)
    const budget = {
      policyVersion: 'lookup-integration-budget-v1',
      maxSourceCostMicrousd: 1_000,
      maxWorkspaceDailyCostMicrousd: 10_000,
      maxOutputTokens: 128,
      pricing: {
        version: 'lookup-integration-pricing-v1',
        inputMicrousdPerMillionTokens: 1_000,
        outputMicrousdPerMillionTokens: 2_000,
        cacheReadMicrousdPerMillionTokens: 100,
        cacheWriteMicrousdPerMillionTokens: 1_250,
      },
    }
    const claim = await repository.claimExtraction({
      source,
      workerId: 'lookup-integration-worker',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: {
        extractorKey: 'lookup-integration-extractor',
        extractorVersion: 'v1',
        promptVersion: 'memory-extractor-v1',
        consentPolicyVersion: 'workspace-memory-v1',
        retentionDays: 30,
        modelProfile: {
          profile: 'scripted-memory', provider: 'scripted', model: 'scripted-memory-v1',
        },
        budget,
      },
    })
    if (claim.status !== 'claimed') throw new Error('Expected lookup integration claim')
    const effectKey = 'model:memory-extract:attempt:1'
    const reservation = await repository.reserveEffect({
      ...claim.identity,
      effectKey,
      requestFingerprint: fingerprintEffectRequest({ source, attempt: 1 }),
      provider: 'scripted',
      model: 'scripted-memory-v1',
      budget: { maximumCostMicrousd: 100, policy: budget },
    })
    if (reservation.status !== 'reserved') throw new Error('Expected lookup reservation')
    await repository.finishEffect({
      ...claim.identity,
      effectKey,
      outcome: 'uncertain',
      metadata: {
        provider: 'scripted',
        model: 'scripted-memory-v1',
        requestId: 'lookup-integration-request-1',
        latencyMs: 1,
      },
      errorCode: 'provider_outcome_unknown',
      errorMessage: 'Provider outcome cannot be proven locally.',
    })
    await repository.failExtraction({
      ...claim.identity,
      outcome: 'uncertain',
      retryable: false,
      maxAttempts: 3,
      errorCode: 'provider_outcome_unknown',
      errorMessage: 'Provider outcome cannot be proven locally.',
    })

    const lookup = new ScriptedProviderRequestLookup({
      provider: 'scripted',
      records: {
        'lookup-integration-request-1': {
          status: 'succeeded',
          provider: 'scripted',
          model: 'scripted-memory-v1',
          requestId: 'lookup-integration-request-1',
          evidenceFingerprint: `sha256:${'f'.repeat(64)}`,
          usage: { inputTokens: 20, outputTokens: 5 },
        },
      },
    })
    const reconciliation = new MemoryExtractionReconciliationService(
      createMemoryExtractionReconciliationRepository(db),
      [lookup],
    )
    const owner = {
      workspaceId: SYSTEM_WORKSPACE_ID,
      principalId: SYSTEM_PRINCIPAL_ID,
      authorization: 'verified-membership' as const,
      role: 'owner' as const,
    }
    await expect(reconciliation.lookupAndReconcile(owner, {
      source,
      effectId: reservation.effect.id,
      idempotencyKey: 'lookup-integration-resolution-1',
    })).resolves.toMatchObject({
      status: 'reconciled', providerStatus: 'succeeded', replayed: false,
    })
    await expect(reconciliation.lookupAndReconcile(owner, {
      source,
      effectId: reservation.effect.id,
      idempotencyKey: 'lookup-integration-resolution-1',
    })).resolves.toMatchObject({
      status: 'reconciled', providerStatus: 'succeeded', replayed: true,
    })
    expect(await repository.getExtractionLedger(source)).toMatchObject({
      task: { status: 'failed', errorCode: 'reconciled_result_unavailable' },
      attempts: [{ status: 'failed', errorCode: 'reconciled_result_unavailable' }],
      effects: [{
        status: 'succeeded', providerRequestId: 'lookup-integration-request-1', costMicrousd: 2,
      }],
    })
  })
})
