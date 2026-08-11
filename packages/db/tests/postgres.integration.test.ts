import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { count, eq } from 'drizzle-orm'
import {
  fingerprintEvalDataset,
  fingerprintEvalModelExecutionBinding,
  type EvalModelExecutionBinding,
} from '@vibe-writer/eval-core'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPostgresDatabase } from '../src/client'
import {
  createJobRepository,
  fingerprintEffectRequest,
} from '../src/repositories/jobs'
import { createOutboxRepository } from '../src/repositories/outbox'
import { createCommandRepository } from '../src/repositories/commands'
import { createArticleRepository } from '../src/repositories/articles'
import { createWorkspaceScopedRepositories } from '../src/repositories/scoped'
import { createWorkspaceRepository } from '../src/repositories/workspaces'
import { createEvalCandidateRepository } from '../src/repositories/eval-candidates'
import { createEvalSamplingRepository } from '../src/repositories/eval-sampling'
import { createEvalMaterializationRepository } from '../src/repositories/eval-materialization'
import { createMemoryRepository } from '../src/repositories/memories'
import { createMemoryExtractionRepository } from '../src/repositories/memory-extractions'
import { createMemoryExtractionReconciliationRepository } from '../src/repositories/memory-reconciliations'
import { createMemorySourceSignalRepository } from '../src/repositories/memory-source-signals'
import { createMemoryCalibrationAuthorizationRepository } from '../src/repositories/memory-calibrations'
import { createTerminalRepository } from '../src/repositories/terminals'
import {
  articles,
  evalCandidates,
  evalCases,
  evalSamplingPolicies,
  jobCommands,
  jobEvents,
  jobs,
  memories,
  memoryCandidateEvents,
  memoryCalibrationAuthorizationEvents,
  memoryCalibrationAuthorizations,
  memoryCandidates,
  memoryExtractionAttempts,
  memoryExtractionEffects,
  memoryExtractionReconciliations,
  memoryExtractionTasks,
  memoryRevisions,
  memorySourceSignalTombstones,
  memoryTombstones,
  outboxEvents,
  runEffects,
  runs,
} from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is required for the real PostgreSQL integration suite')
}
const destructiveTestId = process.env.VIBE_WRITER_POSTGRES_TEST_ID
if (!destructiveTestId || !/^[0-9a-f]{32}$/.test(destructiveTestId)) {
  throw new Error(
    'VIBE_WRITER_POSTGRES_TEST_ID must identify a harness-created disposable database',
  )
}
const expectedDatabaseName = `vibe_writer_integration_${destructiveTestId}`
const expectedDatabaseComment = `vibe-writer-ephemeral:${destructiveTestId}`

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const primary = createPostgresDatabase(connectionString, { max: 1 })
const secondary = createPostgresDatabase(connectionString, { max: 1 })
const primaryRepository = createJobRepository(primary.db)
const secondaryRepository = createJobRepository(secondary.db)
const primaryOutbox = createOutboxRepository(primary.db)
const secondaryOutbox = createOutboxRepository(secondary.db)
const primaryTerminal = createTerminalRepository(primary.db)
const secondaryTerminal = createTerminalRepository(secondary.db)
const primaryCommands = createCommandRepository(primary.db)
const secondaryCommands = createCommandRepository(secondary.db)
const primaryArticles = createArticleRepository(primary.db)
const secondaryArticles = createArticleRepository(secondary.db)
const primarySampling = createEvalSamplingRepository(primary.db)
const secondarySampling = createEvalSamplingRepository(secondary.db)
const primaryMaterialization = createEvalMaterializationRepository(primary.db)
const primaryMemory = createMemoryRepository(primary.db)
const primaryMemoryExtraction = createMemoryExtractionRepository(primary.db)
const secondaryMemoryExtraction = createMemoryExtractionRepository(secondary.db)
const primaryMemoryReconciliations = createMemoryExtractionReconciliationRepository(primary.db)
const secondaryMemoryReconciliations = createMemoryExtractionReconciliationRepository(secondary.db)
const primaryMemorySourceSignals = createMemorySourceSignalRepository(primary.db)
const secondaryMemorySourceSignals = createMemorySourceSignalRepository(secondary.db)

const execution = {
  modelProfile: { profile: 'postgres-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'postgres-test-revision',
}

const memoryExecution = {
  extractorKey: 'postgres-memory-extractor',
  extractorVersion: 'v1',
  promptVersion: 'postgres-memory-prompt-v1',
  consentPolicyVersion: 'postgres-memory-consent-v1',
  retentionDays: 30,
  modelProfile: {
    profile: 'postgres-memory',
    provider: 'scripted',
    model: 'scripted-memory-v1',
  },
}

async function createJob(idempotencyKey: string = randomUUID()) {
  return primaryRepository.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey,
    topic: 'Real PostgreSQL fencing',
    intervention: { on_outline: true },
    target_words: 1200,
  })
}

beforeAll(async () => {
  const [target] = await primary.client<
    { database: string; address: string | null; comment: string | null }[]
  >`
    SELECT
      current_database() AS database,
      host(inet_server_addr()) AS address,
      shobj_description(oid, 'pg_database') AS comment
    FROM pg_database
    WHERE datname = current_database()
  `
  if (
    target?.database !== expectedDatabaseName ||
    target.address !== '127.0.0.1' ||
    target.comment !== expectedDatabaseComment
  ) {
    throw new Error(
      `Refusing destructive PostgreSQL tests for unverified target ${JSON.stringify(target)}`,
    )
  }

  await migrate(primary.db, { migrationsFolder })
  const [primaryPid] = await primary.client<{ pid: number }[]>`select pg_backend_pid() as pid`
  const [secondaryPid] = await secondary.client<{ pid: number }[]>`select pg_backend_pid() as pid`
  expect(primaryPid?.pid).not.toBe(secondaryPid?.pid)
})

beforeEach(async () => {
  await primary.client.unsafe(
    'TRUNCATE TABLE memory_calibration_authorization_events, memory_calibration_authorizations, memory_source_signal_tombstones, memory_source_signals, memory_extraction_effects, memory_extraction_attempts, memory_extraction_tasks, memory_tombstones, memory_candidate_events, memory_revisions, memories, memory_candidates, eval_scores, eval_trials, eval_runs, eval_cases, eval_suites, eval_candidate_events, eval_candidates, eval_sampling_policies, checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs CASCADE;',
  )
})

afterAll(async () => {
  await Promise.all([primary.close(), secondary.close()])
})

describe('real PostgreSQL multi-session fencing', () => {
  it('lets concurrent Memory retention workers skip locked source rows', async () => {
    const scope = await createWorkspaceRepository(primary.db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `retention-lock-${randomUUID().slice(0, 8)}`,
      name: 'Retention lock workspace',
    })
    const first = await primaryMemorySourceSignals.create(scope, {
      idempotencyKey: 'retention-lock-first',
      sourceKind: 'explicit_remember',
      subject: { kind: 'principal', key: scope.principalId },
      text: 'First expired retention signal.',
      consentPolicyVersion: 'memory-consent-v1',
      retentionDays: 30,
    })
    const second = await primaryMemorySourceSignals.create(scope, {
      idempotencyKey: 'retention-lock-second',
      sourceKind: 'explicit_remember',
      subject: { kind: 'principal', key: scope.principalId },
      text: 'Second expired retention signal.',
      consentPolicyVersion: 'memory-consent-v1',
      retentionDays: 30,
    })
    await primary.client`
      UPDATE memory_source_signals
      SET retention_until = '2000-01-01T00:00:00Z'
      WHERE id IN (${first.signal.id}, ${second.signal.id})
    `
    await primary.client.begin(async (transaction) => {
      const locked = await transaction<{ id: string }[]>`
        SELECT id FROM memory_source_signals
        WHERE retention_until <= clock_timestamp()
        ORDER BY retention_until, id
        LIMIT 1
        FOR UPDATE
      `
      expect(locked).toHaveLength(1)
      await expect(secondaryMemorySourceSignals.expireDue(1)).resolves.toEqual({
        signalsDeleted: 1,
      })
      const remaining = await transaction<{ id: string }[]>`
        SELECT id FROM memory_source_signals
        WHERE retention_until <= clock_timestamp()
      `
      expect(remaining).toEqual(locked)
    })
    await expect(primaryMemorySourceSignals.expireDue(1)).resolves.toEqual({
      signalsDeleted: 1,
    })
    expect(await primaryMemorySourceSignals.inspectExpiryBacklog()).toEqual({
      signalsDue: 0,
      signalsCapped: false,
    })
    expect(await primary.db.select().from(memorySourceSignalTombstones)).toHaveLength(2)
  })

  it('isolates Memory calibration authorization and its append-only audit with RLS', async () => {
    const workspaces = createWorkspaceRepository(primary.db)
    const first = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `calibration-rls-first-${randomUUID().slice(0, 8)}`,
      name: 'Calibration RLS first',
    })
    const second = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `calibration-rls-second-${randomUUID().slice(0, 8)}`,
      name: 'Calibration RLS second',
    })
    const cases = [{ key: 'case-a', input: { text: 'Synthetic calibration' }, tags: [] }]
    const datasetFingerprint = fingerprintEvalDataset(cases)
    const binding = {
      schemaVersion: 1,
      planKey: 'memory-extraction-live-calibration',
      datasetFingerprint,
      target: {
        provider: 'scripted',
        model: 'scripted-v1',
        modelProfile: 'scripted-calibration-v1',
        promptVersion: 'prompt-v1',
        extractorVersion: 'extractor-v1',
        codeRevision: 'postgres-calibration-test',
      },
      generation: { maxOutputTokens: 64 },
      pricing: {
        version: 'pricing-v1',
        inputMicrousdPerMillionTokens: 1,
        outputMicrousdPerMillionTokens: 1,
        cacheReadMicrousdPerMillionTokens: 0,
        cacheWriteMicrousdPerMillionTokens: 0,
      },
      budget: { maxCalls: 1, maxCostMicrousd: 10 },
    } satisfies EvalModelExecutionBinding
    const bindingFingerprint = fingerprintEvalModelExecutionBinding(binding)
    const repository = createMemoryCalibrationAuthorizationRepository(primary.db)
    const register = (scope: typeof first, suffix: string) => repository.register(scope, {
      idempotencyKey: `calibration-rls-${suffix}`,
      suiteKey: 'memory-extraction-live-calibration',
      suiteVersion: `rls-${suffix}`,
      name: `Calibration RLS ${suffix}`,
      cases,
      binding,
      baseExecution: {
        modelProfile: binding.target.modelProfile,
        promptVersion: binding.target.promptVersion,
        graphVersion: 'memory-extraction-live-calibration-v1',
        toolVersions: { binding: bindingFingerprint },
        codeRevision: binding.target.codeRevision,
      },
      targetKey: 'memory-extraction-live-calibration',
      targetVersion: 'v1',
      trialsPerCase: 1,
    })
    const firstAuthorization = await register(first, 'first')
    await register(second, 'second')

    const apiRole = `vibe_calibration_${destructiveTestId.slice(0, 12)}`
    await primary.client.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`)
    await primary.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiRole}`)
    await primary.client.unsafe(
      `GRANT SELECT ON memory_calibration_authorizations, memory_calibration_authorization_events TO ${apiRole}`,
    )
    const withoutScope = await secondary.client.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
      return transaction<{ id: string }[]>`SELECT id FROM memory_calibration_authorizations`
    })
    expect(withoutScope).toEqual([])
    const visible = await secondary.client.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
      await transaction`SELECT
        set_config('app.principal_id', ${first.principalId}, true),
        set_config('app.workspace_id', ${first.workspaceId}, true)`
      const authorizations = await transaction<{ id: string }[]>`
        SELECT id FROM memory_calibration_authorizations
      `
      const events = await transaction<{ authorization_id: string }[]>`
        SELECT authorization_id FROM memory_calibration_authorization_events
      `
      return { authorizations, events }
    })
    expect(visible).toEqual({
      authorizations: [{ id: firstAuthorization.authorization.id }],
      events: [{ authorization_id: firstAuthorization.authorization.id }],
    })
    expect(await primary.db.select().from(memoryCalibrationAuthorizations)).toHaveLength(2)
    expect(await primary.db.select().from(memoryCalibrationAuthorizationEvents)).toHaveLength(2)
  })

  it('enforces workspace RLS for a non-owner API role and transaction-local scope', async () => {
    const workspaceRepository = createWorkspaceRepository(primary.db)
    const first = await workspaceRepository.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `rls-first-${randomUUID().slice(0, 8)}`,
      name: 'RLS first',
    })
    const second = await workspaceRepository.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `rls-second-${randomUUID().slice(0, 8)}`,
      name: 'RLS second',
    })
    await createWorkspaceScopedRepositories(primary.db, first).jobs.createJob({
      idempotencyKey: 'same-key',
      topic: 'First RLS job',
      intervention: { on_outline: false },
    })
    await createWorkspaceScopedRepositories(primary.db, second).jobs.createJob({
      idempotencyKey: 'same-key',
      topic: 'Second RLS job',
      intervention: { on_outline: false },
    })

    const apiRole = `vibe_api_${destructiveTestId.slice(0, 16)}`
    await primary.client.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`)
    await primary.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiRole}`)
    await primary.client.unsafe(`GRANT SELECT ON jobs TO ${apiRole}`)
    await primary.client.unsafe(`GRANT INSERT ON jobs TO ${apiRole}`)

    const withoutScope = await secondary.client.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
      return transaction<{ topic: string }[]>`SELECT topic FROM jobs`
    })
    expect(withoutScope).toEqual([])

    const visible = await secondary.client.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
      await transaction`SELECT
        set_config('app.principal_id', ${first.principalId}, true),
        set_config('app.workspace_id', ${first.workspaceId}, true)`
      return transaction<{ topic: string }[]>`SELECT topic FROM jobs ORDER BY topic`
    })
    expect(visible).toEqual([{ topic: 'First RLS job' }])

    await expect(secondary.client.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
      await transaction`SELECT
        set_config('app.principal_id', ${first.principalId}, true),
        set_config('app.workspace_id', ${first.workspaceId}, true)`
      await transaction`INSERT INTO jobs (
        workspace_id, created_by_principal_id, idempotency_key, topic
      ) VALUES (
        ${first.workspaceId}, ${second.principalId}, 'forged-creator', 'Forged creator'
      )`
    })).rejects.toThrow()
  })

  it('isolates live Eval candidate pointers and governance events with RLS', async () => {
    const workspaces = createWorkspaceRepository(primary.db)
    const first = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `eval-rls-first-${randomUUID().slice(0, 8)}`,
      name: 'Eval RLS first',
    })
    const second = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `eval-rls-second-${randomUUID().slice(0, 8)}`,
      name: 'Eval RLS second',
    })
    const candidates = createEvalCandidateRepository(primary.db)
    const createCandidate = async (scope: typeof first, suffix: string) => {
      const { job } = await primaryRepository.createJob({
        workspaceId: scope.workspaceId,
        createdByPrincipalId: scope.principalId,
        idempotencyKey: `eval-rls-${suffix}`,
        topic: `Eval RLS ${suffix}`,
        intervention: { on_outline: false },
      })
      const claim = await primaryRepository.claimJob({
        jobId: job.id,
        workerId: `eval-rls-worker-${suffix}`,
        leaseDurationMs: 30_000,
        execution,
      })
      if (!claim) throw new Error('Expected Eval RLS source claim')
      const terminal = await primaryTerminal.completeClaim({
        jobId: job.id,
        runId: claim.run.id,
        leaseToken: claim.leaseToken,
        exportIdempotencyKey: `job:${job.id}:article:export`,
        topic: `Eval RLS ${suffix}`,
        markdown: `# Eval RLS ${suffix}\n\nPrivate content`,
        outputPath: null,
      })
      if (!('article' in terminal)) throw new Error('Expected Eval RLS article')
      const sampled = await candidates.sampleCompletedRun({
        sourceRunId: claim.run.id,
        samplerKey: 'postgres-live-sampler',
        samplerVersion: 'v1',
        sampleRateBps: 10_000,
        consent: { basis: 'workspace_policy', policyVersion: 'consent-v1' },
        retentionUntil: new Date(Date.now() + 86_400_000),
      })
      if (sampled.status !== 'selected') throw new Error('Expected Eval RLS candidate')
      return sampled.candidate
    }
    const firstCandidate = await createCandidate(first, 'first')
    await createCandidate(second, 'second')

    const apiRole = `vibe_eval_api_${destructiveTestId.slice(0, 16)}`
    await primary.client.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`)
    await primary.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiRole}`)
    await primary.client.unsafe(`GRANT SELECT ON eval_candidates, eval_candidate_events TO ${apiRole}`)
    try {
      const visible = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        await transaction`SELECT
          set_config('app.principal_id', ${first.principalId}, true),
          set_config('app.workspace_id', ${first.workspaceId}, true)`
        return {
          candidates: await transaction<{ id: string }[]>`SELECT id FROM eval_candidates`,
          events: await transaction<{ candidate_id: string }[]>`
            SELECT candidate_id FROM eval_candidate_events
          `,
        }
      })
      expect(visible).toEqual({
        candidates: [{ id: firstCandidate.id }],
        events: [{ candidate_id: firstCandidate.id }],
      })
      const withoutScope = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        return transaction<{ id: string }[]>`SELECT id FROM eval_candidates`
      })
      expect(withoutScope).toEqual([])
    } finally {
      await primary.client.unsafe(`DROP OWNED BY ${apiRole}`)
      await primary.client.unsafe(`DROP ROLE ${apiRole}`)
    }
  })

  it('isolates durable Memory content, review events, revisions, and tombstones with RLS', async () => {
    const workspaces = createWorkspaceRepository(primary.db)
    const first = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `memory-rls-first-${randomUUID().slice(0, 8)}`,
      name: 'Memory RLS first',
    })
    const second = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `memory-rls-second-${randomUUID().slice(0, 8)}`,
      name: 'Memory RLS second',
    })
    const createMemoryDataset = async (scope: typeof first, suffix: string) => {
      const { job } = await primaryRepository.createJob({
        workspaceId: scope.workspaceId,
        createdByPrincipalId: scope.principalId,
        idempotencyKey: `memory-rls-${suffix}`,
        topic: `Memory RLS ${suffix}`,
        intervention: { on_outline: false },
      })
      const claim = await primaryRepository.claimJob({
        jobId: job.id,
        workerId: `memory-rls-worker-${suffix}`,
        leaseDurationMs: 30_000,
        execution,
      })
      if (!claim) throw new Error('Expected Memory RLS source claim')
      const terminal = await primaryTerminal.completeClaim({
        jobId: job.id,
        runId: claim.run.id,
        leaseToken: claim.leaseToken,
        exportIdempotencyKey: `job:${job.id}:article:export`,
        topic: `Memory RLS ${suffix}`,
        markdown: `# Memory RLS ${suffix}`,
        outputPath: null,
      })
      if (!('article' in terminal)) throw new Error('Expected Memory RLS article')
      const extraction = await primaryMemoryExtraction.claimExtraction({
        source: { kind: 'run', runId: claim.run.id },
        workerId: `memory-extraction-rls-${suffix}`,
        leaseDurationMs: 30_000,
        maxAttempts: 3,
        execution: memoryExecution,
      })
      if (extraction.status !== 'claimed') throw new Error('Expected Memory extraction RLS claim')
      const effectKey = 'model:memory-extract:attempt:1'
      await primaryMemoryExtraction.reserveEffect({
        ...extraction.identity,
        effectKey,
        requestFingerprint: fingerprintEffectRequest({
          sourceRunId: claim.run.id,
          extractorVersion: memoryExecution.extractorVersion,
        }),
        provider: 'scripted',
        model: 'scripted-memory-v1',
      })
      await primaryMemoryExtraction.finishEffect({
        ...extraction.identity,
        effectKey,
        outcome: 'succeeded',
        metadata: {
          provider: 'scripted',
          model: 'scripted-memory-v1',
          requestId: `postgres-memory-${suffix}`,
          latencyMs: 1,
        },
      })
      const createOne = async (memoryKey: string, extractorVersion: string) => {
        const proposed = await primaryMemory.submitProposal({
          schemaVersion: 2,
          workspaceId: scope.workspaceId,
          subject: { kind: 'workspace', key: 'default' },
          memoryKey,
          kind: 'preference',
          content: `Private Memory ${suffix} ${memoryKey}`,
          proposedBy: 'model',
          confidence: 0.95,
          sensitivity: 'normal',
          consent: { basis: 'workspace_policy', policyVersion: 'memory-consent-v1' },
          source: {
            kind: 'run',
            runId: claim.run.id,
            evidenceFingerprint: `sha256:${createHash('sha256')
              .update(`${claim.run.id}:${memoryKey}`).digest('hex')}`,
          },
          extractor: { key: 'postgres-memory-rls', version: extractorVersion },
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        if (proposed.status !== 'candidate') throw new Error('Expected Memory RLS candidate')
        const materialized = await primaryMemory.reviewCandidate(scope, {
          candidateId: proposed.candidate.id,
          decision: 'materialize',
          reasonCode: 'owner_confirmed_memory',
        })
        if (materialized.status !== 'materialized') {
          throw new Error('Expected materialized Memory RLS row')
        }
        return materialized.memory
      }
      const active = await createOne('writing.tone', 'active-v1')
      const activeSecond = await createOne('writing.audience', 'active-v2')
      const deleted = await createOne('writing.format', 'deleted-v1')
      await primaryMemory.deleteMemory(scope, {
        memoryId: deleted.id,
        reasonCode: 'user_requested_erasure',
      })
      await primaryMemoryExtraction.completeExtraction(extraction.identity, {
        proposalCount: 3,
        candidateCount: 3,
        conflictCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
        createdCount: 3,
        existingCount: 0,
      })
      const activeSignal = await primaryMemorySourceSignals.create(scope, {
        idempotencyKey: `memory-signal-active-${suffix}`,
        sourceKind: 'explicit_remember',
        subject: { kind: 'principal', key: scope.principalId },
        text: `Private user-authored Memory signal ${suffix}`,
        consentPolicyVersion: 'memory-consent-v1',
        retentionDays: 30,
        sourceRunId: claim.run.id,
      })
      const activeSignalSecond = await primaryMemorySourceSignals.create(scope, {
        idempotencyKey: `memory-signal-active-second-${suffix}`,
        sourceKind: 'preference_setting',
        subject: { kind: 'principal', key: scope.principalId },
        text: `Second private user-authored Memory signal ${suffix}`,
        consentPolicyVersion: 'memory-consent-v1',
        retentionDays: 30,
        sourceRunId: claim.run.id,
      })
      const deletedSignal = await primaryMemorySourceSignals.create(scope, {
        idempotencyKey: `memory-signal-deleted-${suffix}`,
        sourceKind: 'correction',
        subject: { kind: 'principal', key: scope.principalId },
        text: `Private deleted Memory signal ${suffix}`,
        consentPolicyVersion: 'memory-consent-v1',
        retentionDays: 30,
        sourceRunId: claim.run.id,
      })
      await primaryMemorySourceSignals.delete(scope, {
        sourceSignalId: deletedSignal.signal.id,
        reasonCode: 'user_requested_source_erasure',
      })
      return {
        memories: [active, activeSecond],
        signals: [activeSignal.signal, activeSignalSecond.signal],
      }
    }
    const firstDataset = await createMemoryDataset(first, 'first')
    await createMemoryDataset(second, 'second')

    const firstMemoryPage = await primaryMemory.listMemoriesPage(first, { limit: 1 })
    expect(firstMemoryPage.items).toHaveLength(1)
    expect(firstMemoryPage.nextCursor).toBeDefined()
    const secondMemoryPage = await primaryMemory.listMemoriesPage(first, {
      limit: 1,
      cursor: firstMemoryPage.nextCursor!,
    })
    expect(secondMemoryPage.items).toHaveLength(1)
    expect(secondMemoryPage.items[0]?.memory.id).not.toBe(
      firstMemoryPage.items[0]?.memory.id,
    )
    expect([
      firstMemoryPage.items[0]?.memory.id,
      secondMemoryPage.items[0]?.memory.id,
    ].sort()).toEqual(firstDataset.memories.map((memory) => memory.id).sort())

    const candidateIds: string[] = []
    let candidateCursor: { id: string } | null = null
    do {
      const page = await primaryMemory.listCandidatesPage(first, {
        limit: 2,
        ...(candidateCursor ? { cursor: candidateCursor } : {}),
      })
      expect(page.items.length).toBeLessThanOrEqual(2)
      for (const candidate of page.items) {
        expect(candidate.workspaceId).toBe(first.workspaceId)
        expect(candidateIds).not.toContain(candidate.id)
        candidateIds.push(candidate.id)
      }
      candidateCursor = page.nextCursor
    } while (candidateCursor)
    const firstCandidates = await primaryMemory.listCandidates(first)
    expect(candidateIds.sort()).toEqual(firstCandidates.map((candidate) => candidate.id).sort())

    const firstSignalPage = await primaryMemorySourceSignals.listOwnPage(first, { limit: 1 })
    expect(firstSignalPage.items).toHaveLength(1)
    expect(firstSignalPage.nextCursor).not.toBeNull()
    const secondSignalPage = await primaryMemorySourceSignals.listOwnPage(first, {
      limit: 1,
      cursor: firstSignalPage.nextCursor!,
    })
    expect(secondSignalPage.items).toHaveLength(1)
    expect(secondSignalPage.nextCursor).toBeNull()
    expect([
      firstSignalPage.items[0]?.id,
      secondSignalPage.items[0]?.id,
    ].sort()).toEqual(firstDataset.signals.map((signal) => signal.id).sort())

    const apiRole = `vibe_memory_api_${destructiveTestId.slice(0, 16)}`
    await primary.client.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`)
    await primary.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiRole}`)
    await primary.client.unsafe(`GRANT SELECT ON memories, memory_candidates, memory_revisions, memory_candidate_events, memory_tombstones, memory_extraction_tasks, memory_extraction_attempts, memory_extraction_effects, memory_source_signals, memory_source_signal_tombstones TO ${apiRole}`)
    await primary.client.unsafe(`GRANT INSERT ON memory_source_signals TO ${apiRole}`)
    try {
      const visible = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        await transaction`SELECT
          set_config('app.principal_id', ${first.principalId}, true),
          set_config('app.workspace_id', ${first.workspaceId}, true)`
        return {
          memories: await transaction<{ id: string }[]>`SELECT id FROM memories`,
          candidates: await transaction<{ id: string }[]>`SELECT id FROM memory_candidates`,
          revisions: await transaction<{ memory_id: string }[]>`SELECT memory_id FROM memory_revisions`,
          events: await transaction<{ candidate_id: string }[]>`SELECT candidate_id FROM memory_candidate_events`,
          tombstones: await transaction<{ workspace_id: string }[]>`SELECT workspace_id FROM memory_tombstones`,
          extractionTasks: await transaction<{ source_id: string }[]>`SELECT source_id FROM memory_extraction_tasks`,
          extractionAttempts: await transaction<{ source_id: string }[]>`SELECT source_id FROM memory_extraction_attempts`,
          extractionEffects: await transaction<{ source_id: string }[]>`SELECT source_id FROM memory_extraction_effects`,
          sourceSignals: await transaction<{ id: string }[]>`SELECT id FROM memory_source_signals`,
          sourceSignalTombstones: await transaction<{ workspace_id: string }[]>`SELECT workspace_id FROM memory_source_signal_tombstones`,
        }
      })
      expect(visible.memories.map((memory) => memory.id).sort()).toEqual(
        firstDataset.memories.map((memory) => memory.id).sort(),
      )
      expect(visible.candidates).toHaveLength(firstCandidates.length)
      expect(visible.revisions.map((revision) => revision.memory_id).sort()).toEqual(
        firstDataset.memories.map((memory) => memory.id).sort(),
      )
      expect(visible.events).toHaveLength(firstCandidates.length * 2)
      expect(visible.tombstones).toEqual([{ workspace_id: first.workspaceId }])
      expect(visible.extractionTasks).toHaveLength(1)
      expect(visible.extractionAttempts).toHaveLength(1)
      expect(visible.extractionEffects).toHaveLength(1)
      expect(visible.sourceSignals.map((signal) => signal.id).sort()).toEqual(
        firstDataset.signals.map((signal) => signal.id).sort(),
      )
      expect(visible.sourceSignalTombstones).toEqual([{ workspace_id: first.workspaceId }])

      const withoutScope = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        return {
          extractionTasks: await transaction<{ source_id: string }[]>`SELECT source_id FROM memory_extraction_tasks`,
          sourceSignals: await transaction<{ id: string }[]>`SELECT id FROM memory_source_signals`,
          sourceSignalTombstones: await transaction<{ source_signal_id: string }[]>`SELECT source_signal_id FROM memory_source_signal_tombstones`,
        }
      })
      expect(withoutScope).toEqual({
        extractionTasks: [],
        sourceSignals: [],
        sourceSignalTombstones: [],
      })

      await expect(secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        await transaction`SELECT
          set_config('app.principal_id', ${first.principalId}, true),
          set_config('app.workspace_id', ${first.workspaceId}, true)`
        await transaction`
          INSERT INTO memory_source_signals (
            workspace_id, created_by_principal_id, idempotency_key,
            request_fingerprint, source_kind, subject_kind, subject_key,
            source_text, evidence_fingerprint, consent_policy_version,
            retention_until
          ) VALUES (
            ${first.workspaceId}, ${second.principalId}, 'rls-impersonation',
            ${`sha256:${'a'.repeat(64)}`}, 'explicit_remember', 'principal',
            ${second.principalId}, 'impersonated signal', ${`sha256:${'b'.repeat(64)}`},
            'memory-consent-v1', clock_timestamp() + interval '30 days'
          )
        `
      })).rejects.toThrow()
    } finally {
      await primary.client.unsafe(`DROP OWNED BY ${apiRole}`)
      await primary.client.unsafe(`DROP ROLE ${apiRole}`)
    }
  })

  it('isolates sampling policies with RLS and scans separate workspaces concurrently', async () => {
    const workspaces = createWorkspaceRepository(primary.db)
    const first = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `sampling-first-${randomUUID().slice(0, 8)}`,
      name: 'Sampling first',
    })
    const second = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `sampling-second-${randomUUID().slice(0, 8)}`,
      name: 'Sampling second',
    })
    const policyInput = {
      samplerKey: 'completed-production-run',
      samplerVersion: 'v1',
      sampleRateBps: 10_000,
      consentPolicyVersion: 'workspace-eval-consent-v1',
      retentionDays: 30,
    }
    const firstPolicy = await primarySampling.configurePolicy(first, policyInput)
    await primarySampling.configurePolicy(second, policyInput)

    const createSource = async (scope: typeof first, suffix: string) => {
      const { job } = await primaryRepository.createJob({
        workspaceId: scope.workspaceId,
        createdByPrincipalId: scope.principalId,
        idempotencyKey: `sampling-source-${suffix}`,
        topic: `Sampling source ${suffix}`,
        intervention: { on_outline: false },
      })
      const claim = await primaryRepository.claimJob({
        jobId: job.id,
        workerId: `sampling-worker-${suffix}`,
        leaseDurationMs: 30_000,
        execution,
      })
      if (!claim) throw new Error('Expected sampling source claim')
      const terminal = await primaryTerminal.completeClaim({
        jobId: job.id,
        runId: claim.run.id,
        leaseToken: claim.leaseToken,
        exportIdempotencyKey: `job:${job.id}:article:export`,
        topic: `Sampling source ${suffix}`,
        markdown: `# Sampling source ${suffix}\n\nPrivate content`,
        outputPath: null,
      })
      if (!('article' in terminal)) throw new Error('Expected sampling source article')
    }
    await createSource(first, 'first')
    await createSource(second, 'second')

    const apiRole = `vibe_sampling_api_${destructiveTestId.slice(0, 16)}`
    await primary.client.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`)
    await primary.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiRole}`)
    await primary.client.unsafe(`GRANT SELECT ON eval_sampling_policies TO ${apiRole}`)
    await primary.client.unsafe(`
      CREATE OR REPLACE FUNCTION test_delay_eval_policy_scan()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.last_scanned_at IS DISTINCT FROM OLD.last_scanned_at THEN
          PERFORM pg_sleep(0.20);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_delay_eval_policy_scan_trigger
      BEFORE UPDATE ON eval_sampling_policies
      FOR EACH ROW EXECUTE FUNCTION test_delay_eval_policy_scan();
    `)
    try {
      const visible = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        await transaction`SELECT
          set_config('app.principal_id', ${first.principalId}, true),
          set_config('app.workspace_id', ${first.workspaceId}, true)`
        return transaction<{ id: string }[]>`SELECT id FROM eval_sampling_policies`
      })
      expect(visible).toEqual([{ id: firstPolicy.policy.id }])
      const withoutScope = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        return transaction<{ id: string }[]>`SELECT id FROM eval_sampling_policies`
      })
      expect(withoutScope).toEqual([])

      const results = await Promise.all([
        primarySampling.scanActivePolicies({ policyLimit: 1, sourceBatchSize: 10 }),
        secondarySampling.scanActivePolicies({ policyLimit: 1, sourceBatchSize: 10 }),
      ])
      expect(results).toEqual([
        {
          policiesScanned: 1,
          sourcesSeen: 1,
          candidatesCreated: 1,
          candidatesExisting: 0,
          cursorsAdvanced: 1,
        },
        {
          policiesScanned: 1,
          sourcesSeen: 1,
          candidatesCreated: 1,
          candidatesExisting: 0,
          cursorsAdvanced: 1,
        },
      ])
      const [candidateCount] = await primary.db.select({ value: count() }).from(evalCandidates)
      const policies = await primary.db.select().from(evalSamplingPolicies)
      expect(candidateCount?.value).toBe(2)
      expect(policies.every((policy) => policy.lastScannedAt !== null)).toBe(true)
    } finally {
      await primary.client.unsafe(`
        DROP TRIGGER IF EXISTS test_delay_eval_policy_scan_trigger ON eval_sampling_policies;
        DROP FUNCTION IF EXISTS test_delay_eval_policy_scan();
      `)
      await primary.client.unsafe(`DROP OWNED BY ${apiRole}`)
      await primary.client.unsafe(`DROP ROLE ${apiRole}`)
    }
  })

  it('cascades real PostgreSQL signal erasure through derived Memory rows', async () => {
    const scope = await createWorkspaceRepository(primary.db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `memory-signal-cascade-${randomUUID().slice(0, 8)}`,
      name: 'Memory signal cascade',
    })
    const created = await primaryMemorySourceSignals.create(scope, {
      idempotencyKey: 'real-postgres-signal-cascade',
      sourceKind: 'explicit_remember',
      subject: { kind: 'principal', key: scope.principalId },
      text: 'Remember that I prefer concise technical explanations.',
      consentPolicyVersion: 'memory-consent-v1',
      retentionDays: 30,
    })
    const proposed = await primaryMemory.submitProposal({
      schemaVersion: 2,
      workspaceId: scope.workspaceId,
      subject: { kind: 'principal', key: scope.principalId },
      memoryKey: 'writing.tone',
      kind: 'preference',
      content: 'Prefer concise technical explanations.',
      proposedBy: 'model',
      confidence: 0.95,
      sensitivity: 'normal',
      consent: {
        basis: 'explicit_user',
        policyVersion: created.signal.consentPolicyVersion,
      },
      source: {
        kind: 'signal',
        signalId: created.signal.id,
        evidenceFingerprint: created.signal.evidenceFingerprint,
      },
      extractor: { key: 'postgres-signal-memory', version: 'v1' },
      expiresAt: new Date(created.signal.retentionUntil.getTime() - 1_000).toISOString(),
    })
    if (proposed.status !== 'candidate') throw new Error('Expected signal candidate')
    await expect(primaryMemory.reviewCandidate(scope, {
      candidateId: proposed.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_signal_memory',
    })).resolves.toMatchObject({ status: 'materialized' })

    await expect(primaryMemorySourceSignals.delete(scope, {
      sourceSignalId: created.signal.id,
      reasonCode: 'user_revoked_memory_source',
    })).resolves.toMatchObject({ status: 'deleted', replayed: false })
    expect(await primary.db.select().from(memoryCandidates)).toEqual([])
    expect(await primary.db.select().from(memories)).toEqual([])
    expect(await primary.db.select().from(memoryRevisions)).toEqual([])
    expect(await primary.db.select().from(memoryCandidateEvents)).toEqual([])
  })

  it('fences an in-flight signal extraction as uncertain when its source is erased', async () => {
    const scope = await createWorkspaceRepository(primary.db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `memory-signal-inflight-${randomUUID().slice(0, 8)}`,
      name: 'Memory signal in-flight erasure',
    })
    const created = await primaryMemorySourceSignals.create(scope, {
      idempotencyKey: 'real-postgres-inflight-erasure',
      sourceKind: 'explicit_remember',
      subject: { kind: 'principal', key: scope.principalId },
      text: 'Remember this private writing preference.',
      consentPolicyVersion: 'memory-consent-v1',
      retentionDays: 30,
    })
    const claim = await primaryMemoryExtraction.claimExtraction({
      source: { kind: 'signal', signalId: created.signal.id },
      workerId: 'postgres-signal-inflight-worker',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: memoryExecution,
    })
    if (claim.status !== 'claimed') throw new Error('Expected signal extraction claim')
    const effectKey = 'model:memory-extract:attempt:1'
    await primaryMemoryExtraction.reserveEffect({
      ...claim.identity,
      effectKey,
      requestFingerprint: fingerprintEffectRequest({
        source: { kind: 'signal', signalId: created.signal.id },
        evidenceFingerprint: created.signal.evidenceFingerprint,
      }),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    })

    await primaryMemorySourceSignals.delete(scope, {
      sourceSignalId: created.signal.id,
      reasonCode: 'postgres_inflight_source_erasure',
    })
    expect(await primaryMemoryExtraction.getExtractionLedger({
      kind: 'signal', signalId: created.signal.id,
    })).toMatchObject({
      task: {
        status: 'uncertain',
        sourceSignalId: null,
        sourceDeletedAt: expect.any(Date),
        errorCode: 'source_erased',
      },
      attempts: [{ status: 'uncertain', errorCode: 'source_erased' }],
      effects: [{ status: 'uncertain', errorCode: 'source_erased' }],
    })
    await expect(primaryMemoryExtraction.finishEffect({
      ...claim.identity,
      effectKey,
      outcome: 'succeeded',
      metadata: { provider: 'scripted', model: 'scripted-memory-v1', latencyMs: 1 },
    })).resolves.toEqual({ status: 'lease_lost' })
  })

  it('serializes Memory extraction claims and fails closed after an expired provider reservation', async () => {
    const { job } = await createJob('memory-extraction-fencing')
    const sourceClaim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'memory-extraction-source',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!sourceClaim) throw new Error('Expected Memory extraction source claim')
    const terminal = await primaryTerminal.completeClaim({
      jobId: job.id,
      runId: sourceClaim.run.id,
      leaseToken: sourceClaim.leaseToken,
      exportIdempotencyKey: `job:${job.id}:article:export`,
      topic: 'Memory extraction fencing',
      markdown: '# Memory extraction fencing\n\nPrivate content.',
      outputPath: null,
    })
    if (!('article' in terminal)) throw new Error('Expected Memory extraction source article')

    const claimInput = {
      source: { kind: 'run' as const, runId: sourceClaim.run.id },
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: memoryExecution,
    }
    const [primaryResult, secondaryResult] = await Promise.all([
      primaryMemoryExtraction.claimExtraction({
        ...claimInput,
        workerId: 'memory-primary',
      }),
      secondaryMemoryExtraction.claimExtraction({
        ...claimInput,
        workerId: 'memory-secondary',
      }),
    ])
    expect([primaryResult.status, secondaryResult.status].sort()).toEqual(['busy', 'claimed'])
    const claimed = primaryResult.status === 'claimed' ? primaryResult : secondaryResult
    if (claimed.status !== 'claimed') throw new Error('Expected one Memory extraction claim')
    const takeoverRepository = primaryResult.status === 'claimed'
      ? secondaryMemoryExtraction
      : primaryMemoryExtraction
    await (primaryResult.status === 'claimed'
      ? primaryMemoryExtraction
      : secondaryMemoryExtraction).reserveEffect({
      ...claimed.identity,
      effectKey: 'model:memory-extract:attempt:1',
      requestFingerprint: fingerprintEffectRequest({
        sourceRunId: sourceClaim.run.id,
        evidenceFingerprint: `sha256:${'b'.repeat(64)}`,
      }),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    })
    await primary.db.update(memoryExtractionTasks).set({
      leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
    }).where(eq(memoryExtractionTasks.sourceId, sourceClaim.run.id))

    await expect(takeoverRepository.claimExtraction({
      ...claimInput,
      workerId: 'memory-takeover',
    })).resolves.toEqual({
      status: 'terminal',
      taskStatus: 'uncertain',
      resultMetadata: null,
    })
    expect(await primary.db.select().from(memoryExtractionTasks)).toMatchObject([{
      status: 'uncertain',
      attempt: 1,
      errorCode: 'lease_expired_after_provider_reservation',
    }])
    expect(await primary.db.select().from(memoryExtractionAttempts)).toMatchObject([{
      status: 'uncertain',
      attempt: 1,
    }])
    expect(await primary.db.select().from(memoryExtractionEffects)).toMatchObject([{
      status: 'uncertain',
      effectKey: 'model:memory-extract:attempt:1',
    }])
  })

  it('serializes concurrent workspace Memory cost reservations across sessions', async () => {
    const completedSource = async (suffix: string) => {
      const { job } = await createJob(`memory-budget-${suffix}`)
      const claim = await primaryRepository.claimJob({
        jobId: job.id,
        workerId: `memory-budget-source-${suffix}`,
        leaseDurationMs: 30_000,
        execution,
      })
      if (!claim) throw new Error('Expected Memory budget source claim')
      const terminal = await primaryTerminal.completeClaim({
        jobId: job.id,
        runId: claim.run.id,
        leaseToken: claim.leaseToken,
        exportIdempotencyKey: `job:${job.id}:article:export`,
        topic: `Memory budget ${suffix}`,
        markdown: `# Memory budget ${suffix}\n\nPrivate content.`,
        outputPath: null,
      })
      if (!('article' in terminal)) throw new Error('Expected Memory budget article')
      return claim.run.id
    }
    const [firstRunId, secondRunId] = await Promise.all([
      completedSource('first'),
      completedSource('second'),
    ])
    const budget = {
      policyVersion: 'postgres-memory-budget-v1',
      maxSourceCostMicrousd: 100,
      maxWorkspaceDailyCostMicrousd: 100,
      maxOutputTokens: 256,
      pricing: {
        version: 'postgres-memory-pricing-v1',
        inputMicrousdPerMillionTokens: 1_000,
        outputMicrousdPerMillionTokens: 2_000,
        cacheReadMicrousdPerMillionTokens: 100,
        cacheWriteMicrousdPerMillionTokens: 1_250,
      },
    }
    const [firstClaim, secondClaim] = await Promise.all([
      primaryMemoryExtraction.claimExtraction({
        source: { kind: 'run', runId: firstRunId },
        workerId: 'postgres-budget-primary',
        leaseDurationMs: 30_000,
        maxAttempts: 3,
        execution: { ...memoryExecution, budget },
      }),
      secondaryMemoryExtraction.claimExtraction({
        source: { kind: 'run', runId: secondRunId },
        workerId: 'postgres-budget-secondary',
        leaseDurationMs: 30_000,
        maxAttempts: 3,
        execution: { ...memoryExecution, budget },
      }),
    ])
    if (firstClaim.status !== 'claimed' || secondClaim.status !== 'claimed') {
      throw new Error('Expected two independent Memory budget claims')
    }
    const reserve = (
      repository: typeof primaryMemoryExtraction,
      runId: string,
      identity: typeof firstClaim.identity,
    ) => repository.reserveEffect({
      ...identity,
      effectKey: 'model:memory-extract:attempt:1',
      requestFingerprint: fingerprintEffectRequest({
        sourceRunId: runId,
        budgetPolicyVersion: budget.policyVersion,
      }),
      provider: 'scripted',
      model: 'scripted-memory-v1',
      budget: { maximumCostMicrousd: 60, policy: budget },
    })
    const reservations = await Promise.all([
      reserve(primaryMemoryExtraction, firstRunId, firstClaim.identity),
      reserve(secondaryMemoryExtraction, secondRunId, secondClaim.identity),
    ])
    expect(reservations.map((result) => result.status).sort()).toEqual([
      'budget_rejected',
      'reserved',
    ])
    expect(reservations.find((result) => result.status === 'budget_rejected'))
      .toMatchObject({ reason: 'workspace_daily_limit' })
    expect(await primary.db.select().from(memoryExtractionEffects)).toHaveLength(1)
  })

  it('serializes owner reconciliation and isolates its append-only audit with RLS', async () => {
    const owner = await createWorkspaceRepository(primary.db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `postgres-memory-reconciliation-${randomUUID().slice(0, 8)}`,
      name: 'Postgres Memory reconciliation',
    })
    const { job } = await primaryRepository.createJob({
      workspaceId: owner.workspaceId,
      createdByPrincipalId: owner.principalId,
      idempotencyKey: 'postgres-memory-reconciliation-source',
      topic: 'Postgres Memory reconciliation',
      intervention: { on_outline: false },
    })
    const sourceClaim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'postgres-memory-reconciliation-source',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!sourceClaim) throw new Error('Expected reconciliation source claim')
    const terminal = await primaryTerminal.completeClaim({
      jobId: job.id,
      runId: sourceClaim.run.id,
      leaseToken: sourceClaim.leaseToken,
      exportIdempotencyKey: `job:${job.id}:article:export`,
      topic: 'Postgres Memory reconciliation',
      markdown: '# Postgres Memory reconciliation\n\nPrivate content.',
      outputPath: null,
    })
    if (!('article' in terminal)) throw new Error('Expected reconciliation source article')
    const budget = {
      policyVersion: 'postgres-reconciliation-budget-v1',
      maxSourceCostMicrousd: 1_000,
      maxWorkspaceDailyCostMicrousd: 10_000,
      maxOutputTokens: 128,
      pricing: {
        version: 'postgres-reconciliation-pricing-v1',
        inputMicrousdPerMillionTokens: 1_000,
        outputMicrousdPerMillionTokens: 2_000,
        cacheReadMicrousdPerMillionTokens: 100,
        cacheWriteMicrousdPerMillionTokens: 1_250,
      },
    }
    const source = { kind: 'run' as const, runId: sourceClaim.run.id }
    const extraction = await primaryMemoryExtraction.claimExtraction({
      source,
      workerId: 'postgres-memory-uncertain-worker',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: { ...memoryExecution, budget },
    })
    if (extraction.status !== 'claimed') throw new Error('Expected uncertain extraction claim')
    const effectKey = 'model:memory-extract:attempt:1'
    const reserved = await primaryMemoryExtraction.reserveEffect({
      ...extraction.identity,
      effectKey,
      requestFingerprint: fingerprintEffectRequest({ source, attempt: 1 }),
      provider: 'scripted',
      model: 'scripted-memory-v1',
      budget: { maximumCostMicrousd: 100, policy: budget },
    })
    if (reserved.status !== 'reserved') throw new Error('Expected reconciliation reservation')
    await primaryMemoryExtraction.finishEffect({
      ...extraction.identity,
      effectKey,
      outcome: 'uncertain',
      metadata: {
        provider: 'scripted',
        model: 'scripted-memory-v1',
        requestId: 'postgres-uncertain-request',
        responseId: 'postgres-uncertain-response',
        latencyMs: 1,
      },
      errorCode: 'provider_outcome_unknown',
      errorMessage: 'Provider outcome cannot be proven.',
    })
    await primaryMemoryExtraction.failExtraction({
      ...extraction.identity,
      outcome: 'uncertain',
      retryable: false,
      maxAttempts: 3,
      errorCode: 'provider_outcome_unknown',
      errorMessage: 'Provider outcome cannot be proven.',
    })
    await expect(primaryMemoryReconciliations.getLookupTarget(owner, {
      source,
      effectId: reserved.effect.id,
    })).resolves.toMatchObject({
      source,
      effectId: reserved.effect.id,
      provider: 'scripted',
      model: 'scripted-memory-v1',
      providerRequestId: 'postgres-uncertain-request',
      providerResponseId: 'postgres-uncertain-response',
      budget,
    })
    const reconciliationInput = {
      source,
      effectId: reserved.effect.id,
      idempotencyKey: 'postgres-confirmed-failed-reconciliation',
      decision: 'confirmed_failed' as const,
      retryDisposition: 'requeue' as const,
      maxAttempts: 3,
      evidence: {
        kind: 'provider_lookup' as const,
        fingerprint: `sha256:${'e'.repeat(64)}`,
        providerRequestId: 'postgres-uncertain-request',
        providerResponseId: 'postgres-uncertain-response',
      },
      reasonCode: 'provider_confirmed_failed',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost: { microusd: 0, pricingVersion: budget.pricing.version, currency: 'USD' as const },
    }
    const resolutions = await Promise.all([
      primaryMemoryReconciliations.reconcile(owner, reconciliationInput),
      secondaryMemoryReconciliations.reconcile(owner, reconciliationInput),
    ])
    expect(resolutions.map((result) => result.replayed).sort()).toEqual([false, true])
    expect(await primary.db.select().from(memoryExtractionReconciliations)).toHaveLength(1)
    expect(await primaryMemoryExtraction.getExtractionLedger(source)).toMatchObject({
      task: { status: 'queued' },
      attempts: [{ status: 'failed', errorCode: 'reconciled_provider_failed' }],
      effects: [{
        status: 'failed',
        providerRequestId: 'postgres-uncertain-request',
        providerResponseId: 'postgres-uncertain-response',
        costMicrousd: 0,
      }],
    })

    const apiRole = `vibe_memory_reconcile_${destructiveTestId.slice(0, 12)}`
    await primary.client.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`)
    await primary.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiRole}`)
    await primary.client.unsafe(
      `GRANT SELECT ON memory_extraction_reconciliations TO ${apiRole}`,
    )
    try {
      const visible = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        await transaction`SELECT set_config('app.workspace_id', ${owner.workspaceId}, true)`
        return transaction<{ id: string }[]>`SELECT id FROM memory_extraction_reconciliations`
      })
      expect(visible).toHaveLength(1)
      const isolated = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        await transaction`SELECT set_config('app.workspace_id', ${randomUUID()}, true)`
        return transaction<{ id: string }[]>`SELECT id FROM memory_extraction_reconciliations`
      })
      expect(isolated).toEqual([])
    } finally {
      await primary.client.unsafe(`REVOKE ALL ON memory_extraction_reconciliations FROM ${apiRole}`)
      await primary.client.unsafe(`REVOKE USAGE ON SCHEMA public FROM ${apiRole}`)
      await primary.client.unsafe(`DROP ROLE ${apiRole}`)
    }
  })

  it('isolates materialized user-content cases and cascades source deletion', async () => {
    const workspace = await createWorkspaceRepository(primary.db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `materialization-rls-${randomUUID().slice(0, 8)}`,
      name: 'Materialization RLS',
    })
    const { job } = await primaryRepository.createJob({
      workspaceId: workspace.workspaceId,
      createdByPrincipalId: workspace.principalId,
      idempotencyKey: 'materialization-rls-source',
      topic: 'Materialization RLS private topic',
      intervention: { on_outline: false },
    })
    const claim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'materialization-rls-worker',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!claim) throw new Error('Expected materialization RLS source claim')
    const terminal = await primaryTerminal.completeClaim({
      jobId: job.id,
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
      exportIdempotencyKey: `job:${job.id}:article:export`,
      topic: 'Materialization RLS private topic',
      markdown: '# Materialization RLS\n\nPrivate approved body.',
      outputPath: null,
    })
    if (!('article' in terminal)) throw new Error('Expected materialization RLS article')
    const candidates = createEvalCandidateRepository(primary.db)
    const sampled = await candidates.sampleCompletedRun({
      sourceRunId: claim.run.id,
      samplerKey: 'materialization-rls',
      samplerVersion: 'v1',
      sampleRateBps: 10_000,
      consent: { basis: 'workspace_policy', policyVersion: 'consent-v1' },
      retentionUntil: new Date(Date.now() + 86_400_000),
    })
    if (sampled.status !== 'selected') throw new Error('Expected materialization RLS candidate')
    await candidates.reviewCandidate(workspace, {
      candidateId: sampled.candidate.id,
      decision: 'approved',
      reasonCode: 'approved_for_materialization',
    })
    const materialized = await primaryMaterialization.materializeApprovedCandidates(
      workspace,
      {
        candidateIds: [sampled.candidate.id],
        suiteKey: 'approved-live-articles',
        suiteVersion: 'v1',
        name: 'Approved live articles',
        materializerKey: 'approved-article-copy',
        materializerVersion: 'v1',
      },
    )
    const apiRole = `vibe_materialized_api_${destructiveTestId.slice(0, 16)}`
    await primary.client.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`)
    await primary.client.unsafe(`GRANT USAGE ON SCHEMA public TO ${apiRole}`)
    await primary.client.unsafe(`GRANT SELECT ON eval_suites, eval_cases TO ${apiRole}`)
    try {
      const visible = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        await transaction`SELECT
          set_config('app.principal_id', ${workspace.principalId}, true),
          set_config('app.workspace_id', ${workspace.workspaceId}, true)`
        return transaction<{ id: string; input: unknown }[]>`
          SELECT id, input FROM eval_cases
        `
      })
      expect(visible).toHaveLength(1)
      expect(JSON.stringify(visible[0]?.input)).toContain('Private approved body')
      const withoutScope = await secondary.client.begin(async (transaction) => {
        await transaction.unsafe(`SET LOCAL ROLE ${apiRole}`)
        return transaction<{ id: string }[]>`SELECT id FROM eval_cases`
      })
      expect(withoutScope).toEqual([])

      await primary.db.delete(jobs).where(eq(jobs.id, job.id))
      const remaining = await primary.db
        .select()
        .from(evalCases)
        .where(eq(evalCases.suiteId, materialized.suite.id))
      expect(remaining).toEqual([])
    } finally {
      await primary.client.unsafe(`DROP OWNED BY ${apiRole}`)
      await primary.client.unsafe(`DROP ROLE ${apiRole}`)
    }
  })

  it('claims an outbox row once and fences a stale dispatcher token', async () => {
    await createJob('postgres-outbox-claim')
    const [firstBatch, secondBatch] = await Promise.all([
      primaryOutbox.claimBatch({
        dispatcherId: 'dispatcher-primary',
        aggregateType: 'job',
        limit: 10,
        lockTimeoutMs: 30_000,
      }),
      secondaryOutbox.claimBatch({
        dispatcherId: 'dispatcher-secondary',
        aggregateType: 'job',
        limit: 10,
        lockTimeoutMs: 30_000,
      }),
    ])
    const [winner] = [...firstBatch, ...secondBatch]
    expect(winner).toBeDefined()
    expect([...firstBatch, ...secondBatch]).toHaveLength(1)
    await expect(
      secondaryOutbox.markPublished({
        eventId: winner!.id,
        lockToken: randomUUID(),
      }),
    ).resolves.toBe('lease_lost')
    await expect(
      primaryOutbox.markPublished({
        eventId: winner!.id,
        lockToken: winner!.lockToken,
      }),
    ).resolves.toBe('published')
  })

  it('rechecks the wall clock after a row-lock wait crosses lease expiry', async () => {
    const { job } = await createJob('postgres-lock-wait-expiry')
    const claim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-primary',
      leaseDurationMs: 150,
      execution,
    })
    expect(claim).not.toBeNull()
    const identity = {
      jobId: job.id,
      runId: claim!.run.id,
      leaseToken: claim!.leaseToken,
    }
    await primaryRepository.reserveRunEffect({
      ...identity,
      effectKey: 'chapter:lock-wait:model:write:1',
      effectType: 'model_call',
      requestFingerprint: fingerprintEffectRequest({ prompt: 'lock-wait' }),
    })

    let rowLocked: (() => void) | undefined
    const lockAcquired = new Promise<void>((resolve) => {
      rowLocked = resolve
    })
    const blocker = primary.client.begin(async (transaction) => {
      await transaction`SELECT id FROM jobs WHERE id = ${job.id} FOR UPDATE`
      rowLocked?.()
      await transaction`SELECT pg_sleep(0.25)`
    })
    await lockAcquired

    const staleFinish = secondaryRepository.finishRunEffect({
      ...identity,
      effectKey: 'chapter:lock-wait:model:write:1',
      outcome: 'succeeded',
    })
    await blocker
    await expect(staleFinish).resolves.toEqual({ status: 'lease_lost' })
    const [effect] = await primary.db
      .select()
      .from(runEffects)
      .where(eq(runEffects.jobId, job.id))
    expect(effect?.status).toBe('reserved')
  })

  it('serializes duplicate claims across backend sessions and rechecks the predicate', async () => {
    const { job } = await createJob('postgres-duplicate-claim')
    await primary.client.unsafe(`
      CREATE OR REPLACE FUNCTION test_delay_queued_claim()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'queued' AND NEW.status = 'running' THEN
          PERFORM pg_sleep(0.20);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_delay_queued_claim_trigger
      BEFORE UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION test_delay_queued_claim();
    `)

    try {
      const startedAt = performance.now()
      const [first, second] = await Promise.all([
        primaryRepository.claimJob({
          jobId: job.id,
          workerId: 'worker-primary',
          leaseDurationMs: 30_000,
          execution,
        }),
        secondaryRepository.claimJob({
          jobId: job.id,
          workerId: 'worker-secondary',
          leaseDurationMs: 30_000,
          execution,
        }),
      ])
      const elapsedMs = performance.now() - startedAt

      expect(elapsedMs).toBeGreaterThanOrEqual(180)
      expect([first, second].filter(Boolean)).toHaveLength(1)
      const [runCount] = await primary.db
        .select({ value: count() })
        .from(runs)
        .where(eq(runs.jobId, job.id))
      expect(runCount?.value).toBe(1)
      expect((await primaryRepository.getJob(job.id))?.version).toBe(1)
    } finally {
      await primary.client.unsafe(`
        DROP TRIGGER IF EXISTS test_delay_queued_claim_trigger ON jobs;
        DROP FUNCTION IF EXISTS test_delay_queued_claim();
      `)
    }
  })

  it('allocates contiguous events and replays duplicate keys across sessions', async () => {
    const { job } = await createJob('postgres-event-order')
    const claim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-primary',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(claim).not.toBeNull()
    const identity = {
      jobId: job.id,
      runId: claim!.run.id,
      leaseToken: claim!.leaseToken,
    }
    const duplicateInput = {
      ...identity,
      idempotencyKey: 'stage:plan:entered',
      event: { event: 'stage_update' as const, data: { stage: 'plan' as const } },
    }

    const duplicateResults = await Promise.all([
      primaryRepository.appendRunEvent(duplicateInput),
      secondaryRepository.appendRunEvent(duplicateInput),
    ])
    expect(duplicateResults.map((result) => result.status).sort()).toEqual([
      'appended',
      'replayed',
    ])

    const additional = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        (index % 2 === 0 ? primaryRepository : secondaryRepository).appendRunEvent({
          ...identity,
          idempotencyKey: `chapter:1:chunk:${index}`,
          event: {
            event: 'writing_chapter',
            data: { title: 'Chapter 1', token: String(index) },
          },
        }),
      ),
    )
    expect(additional.every((result) => result.status === 'appended')).toBe(true)

    const events = await primary.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
      .orderBy(jobEvents.seq)
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect((await primaryRepository.getJob(job.id))?.nextEventSeq).toBe(7)
  })

  it('serializes terminal article commits and replays the winner across sessions', async () => {
    const { job } = await createJob('postgres-terminal-commit')
    const claim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-primary',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(claim).not.toBeNull()
    const input = {
      jobId: job.id,
      runId: claim!.run.id,
      leaseToken: claim!.leaseToken,
      exportIdempotencyKey: `job:${job.id}:article:export`,
      topic: 'Real PostgreSQL fencing',
      markdown: '# Real PostgreSQL fencing\n\nDurable terminal body.',
      outputPath: null,
    }

    const results = await Promise.all([
      primaryTerminal.completeClaim(input),
      secondaryTerminal.completeClaim(input),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([
      'committed',
      'replayed',
    ])
    const committed = results.find((result) => 'article' in result)
    expect(committed).toMatchObject({
      article: { jobId: job.id, sourceRunId: claim!.run.id },
      event: { event: 'done', data: { output_path: null, _seq: 0 } },
    })
    const [articleCount] = await primary.db
      .select({ value: count() })
      .from(articles)
      .where(eq(articles.jobId, job.id))
    const [eventCount] = await primary.db
      .select({ value: count() })
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
    expect(articleCount?.value).toBe(1)
    expect(eventCount?.value).toBe(1)
    expect(await primaryRepository.getJob(job.id)).toMatchObject({
      status: 'completed',
      nextEventSeq: 1,
    })
    expect(await primaryRepository.getRun(claim!.run.id)).toMatchObject({
      status: 'completed',
    })
  })

  it('serializes duplicate outline replies and creates one resume outbox event', async () => {
    const { job } = await createJob('postgres-outline-reply')
    const claim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-primary',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(claim).not.toBeNull()
    await expect(
      primaryTerminal.pauseClaim({
        jobId: job.id,
        runId: claim!.run.id,
        leaseToken: claim!.leaseToken,
        interruptId: 'postgres-interrupt-outline',
        outline: ['第一章'],
      }),
    ).resolves.toMatchObject({ status: 'paused' })
    const input = {
      jobId: job.id,
      reply: { message: '确认', outline: ['第一章'] },
    }

    const results = await Promise.all([
      primaryCommands.submitOutlineReply(input),
      secondaryCommands.submitOutlineReply(input),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([
      'queued',
      'replayed',
    ])
    const [commandCount] = await primary.db
      .select({ value: count() })
      .from(jobCommands)
      .where(eq(jobCommands.jobId, job.id))
    const resumeRows = await primary.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'job.resume.requested'))
    expect(commandCount?.value).toBe(1)
    expect(resumeRows).toHaveLength(1)
    expect(await primaryRepository.getJob(job.id)).toMatchObject({ status: 'queued' })
  })

  it('allows one article editor per expected revision across sessions', async () => {
    const { job } = await createJob('postgres-article-revision')
    const claim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-primary',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(claim).not.toBeNull()
    const terminal = await primaryTerminal.completeClaim({
      jobId: job.id,
      runId: claim!.run.id,
      leaseToken: claim!.leaseToken,
      exportIdempotencyKey: `job:${job.id}:article:export`,
      topic: 'Concurrent editing',
      markdown: '# Original',
      outputPath: null,
    })
    if (!('article' in terminal)) throw new Error('Expected article')

    const results = await Promise.all([
      primaryArticles.patchArticle({
        articleId: terminal.article.id,
        content: '# Primary edit',
        expectedRevision: 0,
      }),
      secondaryArticles.patchArticle({
        articleId: terminal.article.id,
        content: '# Secondary edit',
        expectedRevision: 0,
      }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([
      'revision_conflict',
      'updated',
    ])
    expect((await primaryArticles.getArticle(terminal.article.id))?.revision).toBe(1)
    expect(await primaryArticles.listVersions(terminal.article.id)).toHaveLength(1)
  })

  it('makes effect reservation single-winner across sessions', async () => {
    const { job } = await createJob('postgres-effect-reserve')
    const claim = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-primary',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(claim).not.toBeNull()
    const input = {
      jobId: job.id,
      runId: claim!.run.id,
      leaseToken: claim!.leaseToken,
      effectKey: 'chapter:1:model:write:1',
      effectType: 'model_call' as const,
      requestFingerprint: fingerprintEffectRequest({ prompt: 'postgres-model-request' }),
    }

    const results = await Promise.all([
      primaryRepository.reserveRunEffect(input),
      secondaryRepository.reserveRunEffect(input),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([
      'already_reserved',
      'reserved',
    ])
    const [effectCount] = await primary.db
      .select({ value: count() })
      .from(runEffects)
      .where(eq(runEffects.jobId, job.id))
    expect(effectCount?.value).toBe(1)
  })

  it('takes over an expired lease and rejects all stale side-effect writes', async () => {
    const { job } = await createJob('postgres-takeover')
    const first = await primaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-primary',
      leaseDurationMs: 100,
      execution,
    })
    expect(first).not.toBeNull()
    const staleIdentity = {
      jobId: job.id,
      runId: first!.run.id,
      leaseToken: first!.leaseToken,
    }
    await primaryRepository.reserveRunEffect({
      ...staleIdentity,
      effectKey: 'job:export:article',
      effectType: 'export',
      requestFingerprint: fingerprintEffectRequest({ markdownHash: 'postgres-export' }),
    })
    await primaryRepository.appendRunEvent({
      ...staleIdentity,
      idempotencyKey: 'stage:write:entered',
      event: { event: 'stage_update', data: { stage: 'write' } },
    })

    await secondary.client`select pg_sleep(0.15)`
    const second = await secondaryRepository.claimJob({
      jobId: job.id,
      workerId: 'worker-secondary',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(second?.run.attempt).toBe(2)
    await expect(
      secondaryRepository.appendRunEvent({
        jobId: job.id,
        runId: second!.run.id,
        leaseToken: second!.leaseToken,
        idempotencyKey: 'stage:write:entered',
        event: { event: 'stage_update', data: { stage: 'write' } },
      }),
    ).resolves.toMatchObject({ status: 'replayed', event: { data: { _seq: 0 } } })
    await expect(
      primaryRepository.appendRunEvent({
        ...staleIdentity,
        idempotencyKey: 'late:event',
        event: { event: 'stage_update', data: { stage: 'review' } },
      }),
    ).resolves.toEqual({ status: 'lease_lost' })
    await expect(
      primaryRepository.finishRunEffect({
        ...staleIdentity,
        effectKey: 'job:export:article',
        outcome: 'succeeded',
      }),
    ).resolves.toEqual({ status: 'lease_lost' })
    await expect(
      primaryRepository.settleClaim({ ...staleIdentity, outcome: 'completed' }),
    ).resolves.toEqual({ status: 'lease_lost' })

    const [effect] = await secondary.db
      .select()
      .from(runEffects)
      .where(eq(runEffects.jobId, job.id))
    expect(effect).toMatchObject({
      runId: first!.run.id,
      status: 'uncertain',
      errorCode: 'lease_takeover',
    })
    await expect(
      secondaryRepository.reserveRunEffect({
        jobId: job.id,
        runId: second!.run.id,
        leaseToken: second!.leaseToken,
        effectKey: 'job:export:article',
        effectType: 'export',
        requestFingerprint: fingerprintEffectRequest({ markdownHash: 'postgres-export' }),
      }),
    ).resolves.toMatchObject({ status: 'uncertain' })
  })
})
