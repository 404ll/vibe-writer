import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { and, count, eq, sql } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createJobRepository,
  fingerprintEffectRequest,
  type CanonicalJsonValue,
  type RunExecutionSnapshot,
} from '../src/repositories/jobs'
import * as schema from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'
import { jobEvents, jobs, outboxEvents, runEffects, runs } from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const initialMigration = readFileSync(
  new URL('../drizzle/20260806183937_unusual_namorita.sql', import.meta.url),
  'utf8',
)
const leaseMigration = readFileSync(
  new URL('../drizzle/20260806204512_awesome_vengeance.sql', import.meta.url),
  'utf8',
)
const effectMigration = readFileSync(
  new URL('../drizzle/20260806211333_cold_daredevil.sql', import.meta.url),
  'utf8',
)
const eventConstraintMigration = readFileSync(
  new URL('../drizzle/20260806212115_tough_captain_midlands.sql', import.meta.url),
  'utf8',
)

let client: PGlite
let db: PgliteDatabase<typeof schema>

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(
    'TRUNCATE TABLE checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs CASCADE;',
  )
})

afterAll(async () => {
  await client.close()
})

function repository() {
  return createJobRepository(db)
}

const execution = {
  modelProfile: { profile: 'test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'test-revision',
}

async function createJob(idempotencyKey: string = randomUUID()) {
  return repository().createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey,
    topic: 'Durable writing',
    intervention: { on_outline: true },
    style: '',
    target_words: 1200,
  })
}

async function createClaimedJob(idempotencyKey: string, leaseDurationMs = 30_000) {
  const { job } = await createJob(idempotencyKey)
  const claim = await repository().claimJob({
    jobId: job.id,
    workerId: 'worker-a',
    leaseDurationMs,
    execution,
  })
  if (!claim) throw new Error(`Expected job ${job.id} to be claimed`)
  return {
    job,
    claim,
    identity: {
      jobId: job.id,
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
    },
  }
}

describe('migration and constraints', () => {
  it('applies the migration and creates the durable tables', async () => {
    const result = await client.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'jobs', 'runs', 'job_events', 'outbox_events', 'run_effects',
          'checkpoint_attempts'
        )
      ORDER BY tablename
    `)

    expect(result.rows.map((row) => row.tablename)).toEqual([
      'checkpoint_attempts',
      'job_events',
      'jobs',
      'outbox_events',
      'run_effects',
      'runs',
    ])
  })

  it('rejects invalid job and run row shapes in PostgreSQL', async () => {
    await expect(
      db.insert(jobs).values({
        workspaceId: SYSTEM_WORKSPACE_ID,
        createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
        idempotencyKey: 'invalid-target',
        topic: 'Invalid target',
        targetWords: 0,
      }),
    ).rejects.toThrow()

    const { job } = await createJob('run-constraint')
    await expect(
      db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, job.id)),
    ).rejects.toThrow()
    await expect(
      db.update(jobs).set({ heartbeatAt: new Date() }).where(eq(jobs.id, job.id)),
    ).rejects.toThrow()
    await expect(
      db.insert(runs).values({
        jobId: job.id,
        attempt: 0,
        modelProfile: { profile: 'test', provider: 'test', model: 'test' },
        promptVersion: 'prompt-v1',
        graphVersion: 'graph-v1',
        toolVersions: {},
        codeRevision: 'test-revision',
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(runs).values({
        jobId: job.id,
        attempt: 1,
        modelProfile: { profile: 'test', provider: 'test', model: 'test' },
        promptVersion: ' ',
        graphVersion: 'graph-v1',
        toolVersions: {},
        codeRevision: 'test-revision',
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(runs).values({
        jobId: job.id,
        attempt: 1,
        status: 'running',
        modelProfile: { profile: 'test', provider: 'test', model: 'test' },
        promptVersion: 'prompt-v1',
        graphVersion: 'graph-v1',
        toolVersions: {},
        codeRevision: 'test-revision',
      }),
    ).rejects.toThrow()

    await expect(
      client.query(
        `
        UPDATE jobs
        SET status = 'completed'
        WHERE id = $1
      `,
        [job.id],
      ),
    ).rejects.toThrow()

    await expect(
      db.insert(jobEvents).values({
        jobId: job.id,
        seq: 0,
        idempotencyKey: '',
        payloadFingerprint: '',
        eventType: 'stage_update',
        eventData: { stage: 'plan' },
      }),
    ).rejects.toThrow()
  })

  it('upgrades populated v1 running rows into fenced v2 states', async () => {
    const legacyClient = await PGlite.create()

    try {
      await legacyClient.exec(initialMigration)

      const retryJobId = randomUUID()
      const cancelledJobId = randomUUID()
      const heartbeatOnlyJobId = randomUUID()

      await legacyClient.query(
        `
          INSERT INTO jobs (
            id, idempotency_key, topic, status, version,
            cancel_requested_at, heartbeat_at
          ) VALUES
            ($1, 'legacy-retry', 'Retry after migration', 'running', 3, NULL, NULL),
            ($2, 'legacy-cancel', 'Cancel during migration', 'running', 5, now(), NULL),
            ($3, 'legacy-heartbeat', 'Clear stray heartbeat', 'queued', 7, NULL, now())
        `,
        [retryJobId, cancelledJobId, heartbeatOnlyJobId],
      )
      await legacyClient.query(
        `
          INSERT INTO runs (
            job_id, attempt, status, model_profile,
            prompt_version, graph_version, tool_versions, code_revision
          ) VALUES
            ($1, 1, 'running', '{}'::jsonb, '', '', '{}'::jsonb, ''),
            ($2, 1, 'running', '{}'::jsonb, 'prompt-v1', 'graph-v1', '{}'::jsonb, 'revision-v1')
        `,
        [retryJobId, cancelledJobId],
      )

      await expect(legacyClient.exec(leaseMigration)).resolves.toBeDefined()

      const migratedJobs = await legacyClient.query<{
        id: string
        status: string
        version: number
        heartbeat_at: Date | null
        finished_at: Date | null
      }>(
        `
          SELECT id, status, version, heartbeat_at, finished_at
          FROM jobs
          ORDER BY id
        `,
      )
      const jobsById = new Map(migratedJobs.rows.map((row) => [row.id, row]))

      expect(jobsById.get(retryJobId)).toMatchObject({
        status: 'queued',
        version: 4,
        heartbeat_at: null,
        finished_at: null,
      })
      expect(jobsById.get(cancelledJobId)?.status).toBe('cancelled')
      expect(jobsById.get(cancelledJobId)?.version).toBe(6)
      expect(jobsById.get(cancelledJobId)?.finished_at).toBeInstanceOf(Date)
      expect(jobsById.get(heartbeatOnlyJobId)).toMatchObject({
        status: 'queued',
        version: 8,
        heartbeat_at: null,
        finished_at: null,
      })

      const migratedRuns = await legacyClient.query<{
        status: string
        error_code: string | null
        prompt_version: string
        graph_version: string
        code_revision: string
        finished_at: Date | null
      }>(`
        SELECT status, error_code, prompt_version, graph_version, code_revision, finished_at
        FROM runs
        ORDER BY job_id
      `)

      expect(migratedRuns.rows).toHaveLength(2)
      for (const run of migratedRuns.rows) {
        expect(run.status).toBe('failed')
        expect(run.error_code).toBe('lease_protocol_migration')
        expect(run.finished_at).toBeInstanceOf(Date)
      }
      expect(
        migratedRuns.rows.some(
          (run) =>
            run.prompt_version === 'unknown-migrated' &&
            run.graph_version === 'unknown-migrated' &&
            run.code_revision === 'unknown-migrated',
        ),
      ).toBe(true)
    } finally {
      await legacyClient.close()
    }
  })

  it('backfills populated v2 events before adding v3 idempotency constraints', async () => {
    const legacyClient = await PGlite.create()

    try {
      await legacyClient.exec(initialMigration)
      await legacyClient.exec(leaseMigration)
      const jobId = randomUUID()
      await legacyClient.query(
        `
          INSERT INTO jobs (id, idempotency_key, topic)
          VALUES ($1, 'legacy-event-job', 'Legacy event')
        `,
        [jobId],
      )
      await legacyClient.query(
        `
          INSERT INTO job_events (job_id, seq, event_type, event_data)
          VALUES ($1, 0, 'stage_update', '{"stage":"plan"}'::jsonb)
        `,
        [jobId],
      )

      await expect(legacyClient.exec(effectMigration)).resolves.toBeDefined()
      await expect(legacyClient.exec(eventConstraintMigration)).resolves.toBeDefined()

      const migrated = await legacyClient.query<{
        idempotency_key: string
        payload_fingerprint: string
      }>(`
        SELECT idempotency_key, payload_fingerprint
        FROM job_events
        WHERE job_id = '${jobId}'
      `)
      expect(migrated.rows).toHaveLength(1)
      expect(migrated.rows[0]?.idempotency_key).toMatch(/^legacy:event:/)
      expect(migrated.rows[0]?.payload_fingerprint).toMatch(/^legacy-unverified:/)

      const effectTable = await legacyClient.query<{ tablename: string }>(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'run_effects'
      `)
      expect(effectTable.rows).toEqual([{ tablename: 'run_effects' }])
    } finally {
      await legacyClient.close()
    }
  })
})

describe('job repository', () => {
  it('creates one job and one enqueue outbox for repeated idempotent requests', async () => {
    const first = await createJob('request-123')
    const second = await createJob('request-123')

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.job.id).toBe(first.job.id)

    const [jobCount] = await db.select({ value: count() }).from(jobs)
    const [outboxCount] = await db.select({ value: count() }).from(outboxEvents)
    expect(jobCount.value).toBe(1)
    expect(outboxCount.value).toBe(1)
  })

  it('rolls back job creation when the transaction cannot write its outbox', async () => {
    const jobId = randomUUID()
    await db.insert(outboxEvents).values({
      idempotencyKey: `job:${jobId}:enqueue:v1`,
      aggregateType: 'job',
      aggregateId: jobId,
      eventType: 'preexisting-test-event',
      payload: { jobId },
    })

    await expect(
      repository().createJob({
        workspaceId: SYSTEM_WORKSPACE_ID,
        createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
        jobId,
        idempotencyKey: 'request-that-must-roll-back',
        topic: 'Rollback me',
        intervention: { on_outline: true },
      }),
    ).rejects.toThrow()

    const [rolledBackJob] = await db.select().from(jobs).where(eq(jobs.id, jobId))
    expect(rolledBackJob).toBeUndefined()
  })

  it('requires claim/settle for running state and refuses terminal revival', async () => {
    const { job } = await createJob('state-machine')
    const repo = repository()

    await expect(repo.transitionJob(job.id, 'queued', 'running')).resolves.toBeNull()
    const failed = await repo.transitionJob(job.id, 'queued', 'failed')
    expect(failed?.status).toBe('failed')
    expect(failed?.finishedAt).toBeInstanceOf(Date)

    const revived = await repo.transitionJob(job.id, 'failed', 'running')
    expect(revived).toBeNull()
    expect((await repo.getJob(job.id))?.status).toBe('failed')
  })

  it('enforces one run attempt number per job', async () => {
    const { job } = await createJob('run-attempt')
    const repo = repository()
    const input = {
      jobId: job.id,
      attempt: 1,
      modelProfile: { profile: 'default', provider: 'anthropic', model: 'model-a' },
      promptVersion: 'prompt-v1',
      graphVersion: 'graph-v1',
      toolVersions: { search: 'search-v1' },
      codeRevision: 'revision-a',
    }

    await db.insert(runs).values(input)
    await expect(db.insert(runs).values(input)).rejects.toThrow()
  })
})

describe('event ordering and replay', () => {
  it('allocates unique contiguous seq values and replays after a cursor', async () => {
    const { job, identity } = await createClaimedJob('event-order')
    const repo = repository()

    const appended = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repo.appendRunEvent({
          ...identity,
          idempotencyKey: `chapter:1:chunk:${index}`,
          event: {
            event: 'writing_chapter',
            data: { title: 'Chapter 1', token: String(index) },
          },
        }),
      ),
    )

    const appendedSeq = appended
      .map((result) => ('event' in result ? result.event.data._seq : undefined))
      .sort((left, right) => Number(left) - Number(right))
    expect(appendedSeq).toEqual([0, 1, 2, 3, 4, 5, 6, 7])

    const replay = await repo.listEventsAfter(job.id, 4)
    expect(replay.map((event) => event.data._seq)).toEqual([5, 6, 7])
    expect((await repo.getJob(job.id))?.nextEventSeq).toBe(8)
  })

  it('rejects a duplicate event sequence at the database boundary', async () => {
    const { job, identity } = await createClaimedJob('event-unique')
    await repository().appendRunEvent({
      ...identity,
      idempotencyKey: 'stage:plan:entered',
      event: { event: 'stage_update', data: { stage: 'plan' } },
    })

    await expect(
      db.insert(jobEvents).values({
        jobId: job.id,
        seq: 0,
        runId: identity.runId,
        idempotencyKey: 'different-key',
        payloadFingerprint: 'test-fingerprint',
        eventType: 'stage_update',
        eventData: { stage: 'plan' },
      }),
    ).rejects.toThrow()

    const [eventCount] = await db
      .select({ value: count() })
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, job.id), eq(jobEvents.seq, 0)))
    expect(eventCount.value).toBe(1)
  })

  it('replays an identical event key without consuming seq and rejects collisions', async () => {
    const { job, identity } = await createClaimedJob('event-idempotency')
    const repo = repository()
    const input = {
      ...identity,
      idempotencyKey: 'stage:plan:entered',
      event: { event: 'stage_update' as const, data: { stage: 'plan' as const } },
    }

    const first = await repo.appendRunEvent(input)
    const replay = await repo.appendRunEvent(input)
    expect(first.status).toBe('appended')
    expect(replay).toEqual({
      status: 'replayed',
      event: 'event' in first ? first.event : undefined,
    })
    expect((await repo.getJob(job.id))?.nextEventSeq).toBe(1)

    await expect(
      repo.appendRunEvent({
        ...input,
        event: { event: 'stage_update', data: { stage: 'write' } },
      }),
    ).rejects.toThrow('Event idempotency collision')
  })

  it('rejects terminal events and stale run tokens', async () => {
    const { job, claim, identity } = await createClaimedJob('event-fencing')
    const repo = repository()

    await repo.appendRunEvent({
      ...identity,
      idempotencyKey: 'stage:plan:entered',
      event: { event: 'stage_update', data: { stage: 'plan' } },
    })

    await expect(
      repo.appendRunEvent({
        ...identity,
        idempotencyKey: 'terminal:done',
        event: {
          event: 'done',
          data: { output_path: 'output/article.md', article_id: randomUUID() },
        },
      }),
    ).rejects.toThrow('Terminal events must be committed')

    await db
      .update(jobs)
      .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(jobs.id, job.id))
    const takeover = await repo.claimJob({
      jobId: job.id,
      workerId: 'worker-b',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(takeover?.run.attempt).toBe(2)
    await expect(
      repo.appendRunEvent({
        jobId: job.id,
        runId: takeover!.run.id,
        leaseToken: takeover!.leaseToken,
        idempotencyKey: 'stage:plan:entered',
        event: { event: 'stage_update', data: { stage: 'plan' } },
      }),
    ).resolves.toMatchObject({ status: 'replayed', event: { data: { _seq: 0 } } })
    await expect(
      repo.appendRunEvent({
        jobId: job.id,
        runId: claim.run.id,
        leaseToken: claim.leaseToken,
        idempotencyKey: 'late:event',
        event: { event: 'stage_update', data: { stage: 'write' } },
      }),
    ).resolves.toEqual({ status: 'lease_lost' })
  })
})

describe('run effect journal', () => {
  it('rejects values outside the canonical JSON request domain', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const sparse = Array(1) as unknown[]
    const invalidValues = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date('2026-08-07T00:00:00.000Z'),
      new Map([['prompt', 'request-a']]),
      new Set(['request-a']),
      { prompt: undefined },
      sparse,
      circular,
    ]

    for (const value of invalidValues) {
      expect(() =>
        fingerprintEffectRequest(value as CanonicalJsonValue),
      ).toThrow(/Canonical JSON/)
    }
    expect(fingerprintEffectRequest(null)).not.toBe(
      fingerprintEffectRequest({ prompt: null }),
    )
  })

  it('reserves, completes, and replays a stable effect key', async () => {
    const { identity } = await createClaimedJob('effect-success')
    const repo = repository()
    expect(fingerprintEffectRequest({ a: 1, b: 2 })).toBe(
      fingerprintEffectRequest({ b: 2, a: 1 }),
    )
    const input = {
      ...identity,
      effectKey: 'chapter:1:model:write:1',
      effectType: 'model_call' as const,
      requestFingerprint: fingerprintEffectRequest({ prompt: 'request-a' }),
    }

    await expect(
      repo.reserveRunEffect({ ...input, requestFingerprint: 'caller-defined-value' }),
    ).rejects.toThrow('canonical sha256 fingerprint')

    const reserved = await repo.reserveRunEffect(input)
    expect(reserved.status).toBe('reserved')
    await expect(repo.reserveRunEffect(input)).resolves.toMatchObject({
      status: 'already_reserved',
    })

    const finished = await repo.finishRunEffect({
      ...identity,
      effectKey: input.effectKey,
      outcome: 'succeeded',
      resultMetadata: { providerRequestId: 'request-123', inputTokens: 42 },
    })
    expect(finished).toMatchObject({
      status: 'finished',
      effect: {
        status: 'succeeded',
        resultMetadata: { providerRequestId: 'request-123', inputTokens: 42 },
      },
    })
    await expect(
      repo.finishRunEffect({
        ...identity,
        effectKey: input.effectKey,
        outcome: 'succeeded',
        resultMetadata: { ignoredOnReplay: true },
      }),
    ).resolves.toMatchObject({ status: 'replayed' })
    await expect(repo.reserveRunEffect(input)).resolves.toMatchObject({
      status: 'previously_succeeded',
    })
    await expect(
      repo.reserveRunEffect({
        ...input,
        requestFingerprint: fingerprintEffectRequest({ prompt: 'different' }),
      }),
    ).rejects.toThrow('Effect idempotency collision')
  })

  it('records a failed effect and does not silently reserve it again', async () => {
    const { identity } = await createClaimedJob('effect-failed')
    const repo = repository()
    const input = {
      ...identity,
      effectKey: 'chapter:1:search:1',
      effectType: 'search' as const,
      requestFingerprint: fingerprintEffectRequest({ query: 'search-a' }),
    }
    await expect(repo.reserveRunEffect(input)).resolves.toMatchObject({
      status: 'reserved',
    })
    await expect(
      repo.finishRunEffect({
        ...identity,
        effectKey: input.effectKey,
        outcome: 'failed',
        errorCode: 'provider_timeout',
        errorMessage: 'Timed out',
      }),
    ).resolves.toMatchObject({
      status: 'finished',
      effect: { status: 'failed', errorCode: 'provider_timeout' },
    })
    await expect(repo.reserveRunEffect(input)).resolves.toMatchObject({
      status: 'previous_failed',
    })
  })

  it('marks a reserved effect uncertain on takeover and fences stale completion', async () => {
    const { job, claim, identity } = await createClaimedJob('effect-takeover')
    const repo = repository()
    const input = {
      ...identity,
      effectKey: 'job:export:article',
      effectType: 'export' as const,
      requestFingerprint: fingerprintEffectRequest({ markdownHash: 'export-a' }),
    }
    await repo.reserveRunEffect(input)
    await db
      .update(jobs)
      .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(jobs.id, job.id))

    const takeover = await repo.claimJob({
      jobId: job.id,
      workerId: 'worker-b',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(takeover?.run.attempt).toBe(2)
    expect(
      (await db.select().from(runEffects).where(eq(runEffects.effectKey, input.effectKey)))[0],
    ).toMatchObject({ status: 'uncertain', errorCode: 'lease_takeover' })
    await expect(
      repo.finishRunEffect({
        ...identity,
        effectKey: input.effectKey,
        outcome: 'succeeded',
      }),
    ).resolves.toEqual({ status: 'lease_lost' })
    await expect(
      repo.reserveRunEffect({
        jobId: job.id,
        runId: takeover!.run.id,
        leaseToken: takeover!.leaseToken,
        effectKey: input.effectKey,
        effectType: input.effectType,
        requestFingerprint: input.requestFingerprint,
      }),
    ).resolves.toMatchObject({ status: 'uncertain', effect: { runId: claim.run.id } })
  })

  it('marks unfinished reservations uncertain when the owning run settles', async () => {
    const { identity } = await createClaimedJob('effect-terminal')
    const repo = repository()
    await repo.reserveRunEffect({
      ...identity,
      effectKey: 'chapter:1:tool:diagram:1',
      effectType: 'tool_call',
      requestFingerprint: fingerprintEffectRequest({ diagram: 'diagram-a' }),
    })

    await expect(
      repo.settleClaim({ ...identity, outcome: 'failed', errorCode: 'run_failed' }),
    ).resolves.toMatchObject({ status: 'settled' })
    expect(
      (await db.select().from(runEffects).where(eq(runEffects.runId, identity.runId)))[0],
    ).toMatchObject({
      status: 'uncertain',
      errorCode: 'run_terminal_with_reserved_effect',
    })
  })
})

describe('worker lease and fencing protocol', () => {
  it('rejects unbound or empty execution metadata before claiming a job', async () => {
    const { job } = await createJob('claim-unbound')
    const repo = repository()

    const invalidExecutions = [
      { ...execution, promptVersion: '' },
      { ...execution, graphVersion: '' },
      { ...execution, graphVersion: 'prototype-unbound' },
      { ...execution, codeRevision: '' },
      { ...execution, modelProfile: { ...execution.modelProfile, profile: '' } },
      { ...execution, modelProfile: { ...execution.modelProfile, provider: '' } },
      { ...execution, modelProfile: { ...execution.modelProfile, model: '' } },
      { ...execution, toolVersions: {} },
      { ...execution, toolVersions: { writer: '' } },
    ] satisfies RunExecutionSnapshot[]

    for (const invalidExecution of invalidExecutions) {
      await expect(
        repo.claimJob({
          jobId: job.id,
          workerId: 'worker-a',
          leaseDurationMs: 30_000,
          execution: invalidExecution,
        }),
      ).rejects.toThrow('bound, non-empty versions')
    }
    expect((await repo.getJob(job.id))?.status).toBe('queued')
  })

  it('allows only one duplicate claim and creates one running attempt', async () => {
    const { job } = await createJob('claim-once')
    const repo = repository()
    const [first, second] = await Promise.all([
      repo.claimJob({
        jobId: job.id,
        workerId: 'worker-a',
        leaseDurationMs: 30_000,
        execution,
      }),
      repo.claimJob({
        jobId: job.id,
        workerId: 'worker-b',
        leaseDurationMs: 30_000,
        execution,
      }),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
    const claimed = first ?? second
    expect(claimed!.run.leaseExpiresAt).toEqual(claimed!.job.leaseExpiresAt)
    expect(claimed!.run.heartbeatAt).toEqual(claimed!.job.heartbeatAt)
    const [claimMirror] = await db
      .select({
        leaseMatches: sql<boolean>`${jobs.leaseExpiresAt} = ${runs.leaseExpiresAt}`,
        heartbeatMatches: sql<boolean>`${jobs.heartbeatAt} = ${runs.heartbeatAt}`,
      })
      .from(jobs)
      .innerJoin(runs, eq(runs.jobId, jobs.id))
      .where(eq(jobs.id, job.id))
    expect(claimMirror).toEqual({ leaseMatches: true, heartbeatMatches: true })
    const [runCount] = await db
      .select({ value: count() })
      .from(runs)
      .where(eq(runs.jobId, job.id))
    expect(runCount.value).toBe(1)
    expect((await repo.getJob(job.id))?.status).toBe('running')
  })

  it('renews an active claim with the database clock', async () => {
    const { job } = await createJob('heartbeat')
    const repo = repository()
    const claim = await repo.claimJob({
      jobId: job.id,
      workerId: 'worker-a',
      leaseDurationMs: 10_000,
      execution,
    })
    expect(claim).not.toBeNull()
    const originalExpiry = claim!.job.leaseExpiresAt!

    const heartbeat = await repo.heartbeatClaim(
      { jobId: job.id, runId: claim!.run.id, leaseToken: claim!.leaseToken },
      60_000,
    )
    const current = await repo.getJob(job.id)
    const run = await repo.getRun(claim!.run.id)

    expect(heartbeat).toBe('renewed')
    expect(current!.leaseExpiresAt!.getTime()).toBeGreaterThan(originalExpiry.getTime())
    expect(run!.leaseExpiresAt).toEqual(current!.leaseExpiresAt)
    expect(run!.heartbeatAt).toEqual(current!.heartbeatAt)
    const [heartbeatMirror] = await db
      .select({
        leaseMatches: sql<boolean>`${jobs.leaseExpiresAt} = ${runs.leaseExpiresAt}`,
        heartbeatMatches: sql<boolean>`${jobs.heartbeatAt} = ${runs.heartbeatAt}`,
      })
      .from(jobs)
      .innerJoin(runs, eq(runs.jobId, jobs.id))
      .where(eq(jobs.id, job.id))
    expect(heartbeatMirror).toEqual({ leaseMatches: true, heartbeatMatches: true })
  })

  it('reclaims an expired lease and fences the stale worker', async () => {
    const { job } = await createJob('expired-takeover')
    const repo = repository()
    const first = await repo.claimJob({
      jobId: job.id,
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(first).not.toBeNull()
    await db
      .update(jobs)
      .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(jobs.id, job.id))
    await expect(
      repo.heartbeatClaim(
        { jobId: job.id, runId: first!.run.id, leaseToken: first!.leaseToken },
        30_000,
      ),
    ).resolves.toBe('lease_lost')
    await expect(
      repo.settleClaim({
        jobId: job.id,
        runId: first!.run.id,
        leaseToken: first!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toEqual({ status: 'lease_lost' })

    const second = await repo.claimJob({
      jobId: job.id,
      workerId: 'worker-b',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(second).not.toBeNull()
    expect(second!.run.attempt).toBe(2)
    expect(second!.job.startedAt).toEqual(first!.job.startedAt)
    expect(second!.leaseToken).not.toBe(first!.leaseToken)
    expect((await repo.getRun(first!.run.id))?.status).toBe('failed')
    expect((await repo.getRun(first!.run.id))?.errorCode).toBe('lease_expired')

    await expect(
      repo.heartbeatClaim(
        { jobId: job.id, runId: first!.run.id, leaseToken: first!.leaseToken },
        30_000,
      ),
    ).resolves.toBe('lease_lost')
    await expect(
      repo.settleClaim({
        jobId: job.id,
        runId: first!.run.id,
        leaseToken: first!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toEqual({ status: 'lease_lost' })
    expect((await repo.getJob(job.id))?.leaseToken).toBe(second!.leaseToken)
  })

  it('observes cancellation without renewing and settles it with the active token', async () => {
    const { job } = await createJob('cancel-running')
    const repo = repository()
    const claim = await repo.claimJob({
      jobId: job.id,
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(claim).not.toBeNull()

    await expect(repo.requestCancellation(job.id)).resolves.toBe('cancel_requested')
    await expect(
      repo.heartbeatClaim(
        { jobId: job.id, runId: claim!.run.id, leaseToken: claim!.leaseToken },
        30_000,
      ),
    ).resolves.toBe('cancel_requested')
    await expect(
      repo.claimJob({
        jobId: job.id,
        workerId: 'worker-b',
        leaseDurationMs: 30_000,
        execution,
      }),
    ).resolves.toBeNull()
    await expect(
      repo.settleClaim({
        jobId: job.id,
        runId: claim!.run.id,
        leaseToken: claim!.leaseToken,
        outcome: 'completed',
      }),
    ).resolves.toEqual({ status: 'cancel_requested' })

    const settled = await repo.settleClaim({
      jobId: job.id,
      runId: claim!.run.id,
      leaseToken: claim!.leaseToken,
      outcome: 'cancelled',
    })
    expect(settled.status).toBe('settled')
    if (settled.status !== 'settled') throw new Error('Expected cancelled settlement')
    expect(settled.job).toMatchObject({
      status: 'cancelled',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    expect(settled.run.status).toBe('cancelled')
  })

  it('settles job and run once and rejects a duplicate terminal write', async () => {
    const { job } = await createJob('settle-once')
    const repo = repository()
    const claim = await repo.claimJob({
      jobId: job.id,
      workerId: 'worker-a',
      leaseDurationMs: 30_000,
      execution,
    })
    expect(claim).not.toBeNull()
    const identity = {
      jobId: job.id,
      runId: claim!.run.id,
      leaseToken: claim!.leaseToken,
    }

    const completed = await repo.settleClaim({ ...identity, outcome: 'completed' })
    expect(completed.status).toBe('settled')
    if (completed.status !== 'settled') throw new Error('Expected completed settlement')
    expect(completed.job.status).toBe('completed')
    expect(completed.run.status).toBe('completed')
    expect(completed.job.finishedAt).toBeInstanceOf(Date)
    expect(completed.run.finishedAt).toEqual(completed.job.finishedAt)
    const [settleMirror] = await db
      .select({
        finishedMatches: sql<boolean>`${jobs.finishedAt} = ${runs.finishedAt}`,
      })
      .from(jobs)
      .innerJoin(runs, eq(runs.jobId, jobs.id))
      .where(eq(jobs.id, job.id))
    expect(settleMirror?.finishedMatches).toBe(true)
    await expect(
      repo.settleClaim({ ...identity, outcome: 'failed', errorCode: 'late' }),
    ).resolves.toEqual({ status: 'lease_lost' })
  })

  it('cancels queued work immediately and never creates a run', async () => {
    const { job } = await createJob('cancel-queued')
    const repo = repository()

    await expect(repo.requestCancellation(job.id)).resolves.toBe('cancelled')
    await expect(
      repo.claimJob({
        jobId: job.id,
        workerId: 'worker-a',
        leaseDurationMs: 30_000,
        execution,
      }),
    ).resolves.toBeNull()
    const [runCount] = await db
      .select({ value: count() })
      .from(runs)
      .where(eq(runs.jobId, job.id))
    expect(runCount.value).toBe(0)
    expect(await repo.listEventsAfter(job.id)).toEqual([
      { event: 'cancelled', data: { _seq: 0 } },
    ])
  })
})
