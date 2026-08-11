import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { count, eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { runOfflineEval } from '@vibe-writer/eval-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createEvalRepository } from '../src/repositories/evals'
import { createJobRepository, fingerprintEffectRequest } from '../src/repositories/jobs'
import { createTraceRepository } from '../src/repositories/traces'
import * as schema from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const traceEvalMigration = '20260807051314_mushy_misty_knight.sql'
let client: PGlite
let db: PgliteDatabase<typeof schema>

const execution = {
  modelProfile: { profile: 'trace-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'graph-v1',
  toolVersions: { search: 'search-v1' },
  codeRevision: 'trace-test-revision',
}

const evalExecution = {
  modelProfile: execution.modelProfile.profile,
  promptVersion: execution.promptVersion,
  graphVersion: execution.graphVersion,
  toolVersions: execution.toolVersions,
  codeRevision: execution.codeRevision,
}

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      eval_scores, eval_trials, eval_runs, eval_cases, eval_suites,
      trace_spans, checkpoint_attempts, run_effects, job_events, runs,
      outbox_events, jobs CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function claimJob(key: string) {
  const jobs = createJobRepository(db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: key,
    topic: 'Traceable execution',
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: 'trace-worker',
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claim) throw new Error('Expected claim')
  return { jobs, job, claim, identity: {
    jobId: job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
  } }
}

describe('bounded run trace', () => {
  it('backfills trace ids before enforcing the non-null migration', async () => {
    const legacy = await PGlite.create()
    try {
      const migrationFiles = readdirSync(migrationsFolder)
        .filter((file) => file.endsWith('.sql'))
        .sort()
      for (const file of migrationFiles.filter((file) => file < traceEvalMigration)) {
        await legacy.exec(readFileSync(`${migrationsFolder}/${file}`, 'utf8'))
      }
      const jobId = randomUUID()
      const runId = randomUUID()
      await legacy.query(
        `INSERT INTO jobs (id, idempotency_key, topic) VALUES ($1, 'trace-backfill', 'Backfill')`,
        [jobId],
      )
      await legacy.query(
        `INSERT INTO runs (
          id, job_id, attempt, model_profile, prompt_version,
          graph_version, tool_versions, code_revision, trace_id
        ) VALUES ($1, $2, 1, '{}'::jsonb, 'p1', 'g1', '{}'::jsonb, 'r1', NULL)`,
        [runId, jobId],
      )
      await legacy.exec(readFileSync(`${migrationsFolder}/${traceEvalMigration}`, 'utf8'))
      const result = await legacy.query<{ trace_id: string }>(
        'SELECT trace_id FROM runs WHERE id = $1',
        [runId],
      )
      expect(result.rows[0]?.trace_id).toBe(runId)
    } finally {
      await legacy.close()
    }
  })

  it('creates and finishes a queryable span atomically with a fenced effect', async () => {
    const { jobs, claim, identity } = await claimJob('trace-success')
    const fingerprint = fingerprintEffectRequest({ prompt: 'private prompt' })
    await expect(jobs.reserveRunEffect({
      ...identity,
      effectKey: 'model:plan:attempt:1',
      effectType: 'model_call',
      requestFingerprint: fingerprint,
      trace: { operation: 'planner.plan' },
    })).resolves.toMatchObject({ status: 'reserved' })

    const running = await createTraceRepository(db).getRunTrace(claim.run.id)
    expect(running).toMatchObject({
      run: { traceId: expect.any(String), promptVersion: 'prompt-v1' },
      spans: [{
        status: 'running',
        spanKind: 'model',
        operation: 'planner.plan',
        requestFingerprint: fingerprint,
      }],
    })

    await expect(jobs.finishRunEffect({
      ...identity,
      effectKey: 'model:plan:attempt:1',
      outcome: 'succeeded',
      resultMetadata: {
        provider: 'anthropic',
        model: 'claude-test',
        requestId: 'req-1',
        responseId: 'msg-1',
        usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 3 },
        latencyMs: 42,
        finishReason: 'stop',
      },
    })).resolves.toMatchObject({ status: 'finished' })

    const trace = await createTraceRepository(db).getRunTrace(claim.run.id)
    expect(trace?.spans[0]).toMatchObject({
      traceId: claim.run.traceId,
      status: 'succeeded',
      provider: 'anthropic',
      model: 'claude-test',
      providerRequestId: 'req-1',
      providerResponseId: 'msg-1',
      inputTokens: 20,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      latencyMs: 42,
      attributes: { finishReason: 'stop' },
      errorCode: null,
    })
    expect(JSON.stringify(trace)).not.toContain('private prompt')
  })

  it('marks an open span uncertain when its run terminates', async () => {
    const { jobs, claim, identity } = await claimJob('trace-uncertain')
    await jobs.reserveRunEffect({
      ...identity,
      effectKey: 'search:chapter:1',
      effectType: 'search',
      requestFingerprint: fingerprintEffectRequest({ query: 'private query' }),
      trace: { operation: 'search.query' },
    })
    await jobs.settleClaim({ ...identity, outcome: 'failed', errorCode: 'test_failure' })
    const trace = await createTraceRepository(db).getRunTrace(claim.run.id)
    expect(trace?.spans[0]).toMatchObject({
      status: 'uncertain',
      errorCode: 'run_terminal_with_running_span',
    })
  })
})

describe('self-owned offline eval records', () => {
  it('registers a versioned suite and persists a content-free deterministic report', async () => {
    const repository = createEvalRepository(db)
    const cases = [
      { key: 'case-a', input: { value: 2 }, expected: { value: 4 }, tags: ['smoke'] },
      { key: 'case-b', input: { value: 3 }, expected: { value: 6 }, tags: ['smoke'] },
    ]
    const created = await repository.createSuite({
      namespaceKey: 'system',
      suiteKey: 'double',
      version: 'v1',
      name: 'Double deterministic suite',
      status: 'active',
      dataClassification: 'synthetic',
      cases,
    })
    expect(created.created).toBe(true)
    await expect(repository.createSuite({
      namespaceKey: 'system',
      suiteKey: 'double',
      version: 'v1',
      name: 'Double deterministic suite',
      status: 'active',
      dataClassification: 'synthetic',
      cases,
    })).resolves.toMatchObject({ created: false })

    const report = await runOfflineEval(
      cases,
      {
        key: 'double-target',
        version: 'v1',
        execute: async (input) => ({ value: input.value * 2 }),
      },
      [{
        key: 'exact',
        version: 'v1',
        metric: 'exact_match',
        evaluate: (evaluation) => ({
          passed: evaluation.output.value === evaluation.case.expected?.value,
        }),
      }],
      { suite: { key: 'double', version: 'v1' }, execution: evalExecution },
    )
    const persisted = await repository.persistOfflineReport('system', 'ci', report)
    expect(persisted.status).toBe('completed')

    const [trialCount] = await db.select({ value: count() }).from(schema.evalTrials)
    const [scoreCount] = await db.select({ value: count() }).from(schema.evalScores)
    expect(trialCount?.value).toBe(2)
    expect(scoreCount?.value).toBe(2)
    const trials = await db.select().from(schema.evalTrials)
    expect(trials.every((trial) => trial.output === null)).toBe(true)
    expect(trials.every((trial) => /^sha256:/.test(trial.outputFingerprint ?? ''))).toBe(true)
  })

  it('rejects suite version collisions and preserves failed grader outcomes', async () => {
    const repository = createEvalRepository(db)
    const cases = [{ key: 'case-a', input: { value: 1 }, expected: { value: 1 } }]
    await repository.createSuite({
      namespaceKey: 'workspace:demo',
      suiteKey: 'grader-failure',
      version: 'v1',
      name: 'Grader failure',
      status: 'active',
      dataClassification: 'deidentified',
      cases,
    })
    await expect(repository.createSuite({
      namespaceKey: 'workspace:demo',
      suiteKey: 'grader-failure',
      version: 'v1',
      name: 'Grader failure',
      status: 'active',
      dataClassification: 'deidentified',
      cases: [{ key: 'case-a', input: { value: 2 }, expected: { value: 1 } }],
    })).rejects.toThrow('version collision')

    const report = await runOfflineEval(
      cases,
      { key: 'identity', version: 'v1', execute: async (input) => input },
      [{
        key: 'broken', version: 'v1', metric: 'quality',
        evaluate: () => { throw new Error('grader failed') },
      }],
      { suite: { key: 'grader-failure', version: 'v1' }, execution: evalExecution },
    )
    const persisted = await repository.persistOfflineReport('workspace:demo', 'regression', report)
    expect(persisted.status).toBe('failed')
    const [score] = await db.select().from(schema.evalScores)
    expect(score).toMatchObject({ status: 'error', errorCode: 'evaluator_error' })
  })

  it('does not allow an incomplete run to be marked complete', async () => {
    const repository = createEvalRepository(db)
    const cases = [{ key: 'case-a', input: 1 }]
    const suite = await repository.createSuite({
      namespaceKey: 'system', suiteKey: 'incomplete', version: 'v1', name: 'Incomplete',
      status: 'active', dataClassification: 'synthetic', cases,
    })
    const run = await repository.startRun({
      namespaceKey: 'system', suiteKey: 'incomplete', suiteVersion: 'v1',
      datasetFingerprint: suite.suite.datasetFingerprint,
      trigger: 'manual', targetKey: 'target', targetVersion: 'v1',
      execution: evalExecution, trialsPerCase: 1,
    })
    await expect(repository.finishRun(run.id)).rejects.toThrow('incomplete')
    const [stored] = await db.select().from(schema.evalRuns).where(eq(schema.evalRuns.id, run.id))
    expect(stored?.status).toBe('running')
  })

  it('enqueues one content-free Eval request and atomically commits its report', async () => {
    const repository = createEvalRepository(db)
    const cases = [
      { key: 'case-a', input: { value: 2 }, expected: { value: 4 }, tags: ['queue'] },
      { key: 'case-b', input: { value: 3 }, expected: { value: 6 }, tags: ['queue'] },
    ]
    const suite = await repository.createSuite({
      namespaceKey: 'system', suiteKey: 'queued-double', version: 'v1',
      name: 'Queued double', status: 'active', dataClassification: 'synthetic', cases,
    })
    const request = {
      namespaceKey: 'system', suiteKey: 'queued-double', suiteVersion: 'v1',
      datasetFingerprint: suite.suite.datasetFingerprint,
      trigger: 'regression' as const,
      targetKey: 'double-target', targetVersion: 'v1',
      execution: evalExecution, trialsPerCase: 1, idempotencyKey: 'queued-double-v1',
    }
    const first = await repository.enqueueRun(request)
    const duplicate = await repository.enqueueRun(request)
    expect(first).toMatchObject({ created: true, run: { status: 'queued', mode: 'queued' } })
    expect(duplicate).toMatchObject({ created: false, run: { id: first.run.id } })
    const outboxes = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateType, 'eval_run'))
    expect(outboxes).toMatchObject([{
      aggregateId: first.run.id,
      eventType: 'eval.run.requested',
      payload: { evalRunId: first.run.id },
      status: 'pending',
    }])

    const claimed = await repository.claimRun({
      evalRunId: first.run.id, workerId: 'eval-worker-a', leaseDurationMs: 30_000,
    })
    if (claimed.status !== 'claimed' || !claimed.run.leaseToken) {
      throw new Error('Expected queued Eval claim')
    }
    const identity = { evalRunId: first.run.id, leaseToken: claimed.run.leaseToken }
    const context = await repository.getClaimContext(identity)
    expect(context?.cases).toEqual(cases)
    const report = await runOfflineEval(
      cases,
      { key: 'double-target', version: 'v1', execute: async (input) => ({ value: input.value * 2 }) },
      [{
        key: 'exact', version: 'v1', metric: 'exact_match',
        evaluate: ({ output, case: evalCase }) => ({ passed: output.value === evalCase.expected?.value }),
      }],
      { suite: { key: 'queued-double', version: 'v1' }, execution: evalExecution },
    )
    const malformed = structuredClone(report)
    malformed.trials[0]!.trialIndex = 1
    await expect(repository.commitClaimedReport({ ...identity, report: malformed }))
      .rejects.toThrow('Unexpected or duplicate queued Eval trial')
    expect((await repository.getRun(first.run.id))?.status).toBe('running')
    expect(await db.select().from(schema.evalTrials)
      .where(eq(schema.evalTrials.evalRunId, first.run.id))).toEqual([])
    await expect(repository.commitClaimedReport({ ...identity, report }))
      .resolves.toMatchObject({ status: 'committed', run: { status: 'completed' } })
    await expect(repository.commitClaimedReport({ ...identity, report }))
      .resolves.toEqual({ status: 'lease_lost' })
    const [stored] = await db.select().from(schema.evalRuns)
      .where(eq(schema.evalRuns.id, first.run.id))
    expect(stored).toMatchObject({
      status: 'completed', mode: 'queued', attempt: 1,
      leaseOwner: null, leaseToken: null,
    })
    const trials = await db.select().from(schema.evalTrials)
      .where(eq(schema.evalTrials.evalRunId, first.run.id))
    expect(trials).toHaveLength(2)
    expect(trials.every((trial) => trial.output === null)).toBe(true)
  })

  it('takes over an expired Eval lease and fences the stale worker', async () => {
    const repository = createEvalRepository(db)
    const cases = [{ key: 'case-a', input: { value: 1 }, expected: { value: 1 } }]
    const suite = await repository.createSuite({
      namespaceKey: 'system', suiteKey: 'queued-takeover', version: 'v1',
      name: 'Queued takeover', status: 'active', dataClassification: 'synthetic', cases,
    })
    const queued = await repository.enqueueRun({
      namespaceKey: 'system', suiteKey: 'queued-takeover', suiteVersion: 'v1',
      datasetFingerprint: suite.suite.datasetFingerprint,
      trigger: 'regression', targetKey: 'identity', targetVersion: 'v1',
      execution: evalExecution, trialsPerCase: 1, idempotencyKey: 'queued-takeover-v1',
    })
    const first = await repository.claimRun({
      evalRunId: queued.run.id, workerId: 'eval-worker-old', leaseDurationMs: 30_000,
    })
    if (first.status !== 'claimed' || !first.run.leaseToken) throw new Error('Expected first claim')
    await db.update(schema.evalRuns)
      .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(schema.evalRuns.id, queued.run.id))
    const second = await repository.claimRun({
      evalRunId: queued.run.id, workerId: 'eval-worker-new', leaseDurationMs: 30_000,
    })
    if (second.status !== 'claimed' || !second.run.leaseToken) throw new Error('Expected takeover')
    expect(second.run).toMatchObject({ attempt: 2, leaseOwner: 'eval-worker-new' })
    expect(second.run.leaseToken).not.toBe(first.run.leaseToken)
    await expect(repository.heartbeatRun({
      evalRunId: queued.run.id, leaseToken: first.run.leaseToken,
    }, 30_000)).resolves.toBe('lease_lost')
    await expect(repository.failClaim({
      evalRunId: queued.run.id, leaseToken: first.run.leaseToken,
    }, 'stale_worker', 'Stale worker')).resolves.toEqual({ status: 'lease_lost' })
    await expect(repository.failClaim({
      evalRunId: queued.run.id, leaseToken: second.run.leaseToken,
    }, 'eval_executor_failed', 'Executor failed.')).resolves.toMatchObject({
      status: 'failed', run: { status: 'failed', attempt: 2 },
    })
  })
})
