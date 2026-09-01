import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { count, eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createJobRepository, type RunExecutionSnapshot } from '../src/repositories/jobs'
import { createTerminalRepository } from '../src/repositories/terminals'
import * as schema from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'
import { articles, jobEvents, jobs, outboxEvents, runs } from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
let client: PGlite
let db: PgliteDatabase<typeof schema>

const execution = {
  modelProfile: { profile: 'terminal-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'terminal-test-revision',
} satisfies RunExecutionSnapshot

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(
    'TRUNCATE TABLE article_versions, articles, job_commands, job_interrupts, checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs CASCADE;',
  )
})

afterAll(async () => {
  await client.close()
})

async function claim(key: string = randomUUID(), workerId = 'worker-a') {
  const jobsRepository = createJobRepository(db)
  const { job } = await jobsRepository.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: key,
    topic: 'Durable terminal',
    intervention: { on_outline: false },
  })
  const claimed = await jobsRepository.claimJob({
    jobId: job.id,
    workerId,
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claimed) throw new Error('Expected job claim')
  return {
    job,
    claimed,
    identity: {
      jobId: job.id,
      runId: claimed.run.id,
      leaseToken: claimed.leaseToken,
    },
  }
}

function completion(identity: Awaited<ReturnType<typeof claim>>['identity']) {
  return {
    ...identity,
    exportIdempotencyKey: `job:${identity.jobId}:article:export`,
    topic: 'Durable terminal',
    markdown: '# Durable terminal\n\n正文',
    outputPath: null,
  }
}

describe('terminal repository', () => {
  it('atomically commits article, done event and job/run terminal state', async () => {
    const current = await claim('terminal-complete')
    const jobsRepository = createJobRepository(db)
    await jobsRepository.appendRunEvent({
      ...current.identity,
      idempotencyKey: 'stage:export',
      event: { event: 'stage_update', data: { stage: 'export' } },
    })

    const result = await createTerminalRepository(db).completeClaim(
      completion(current.identity),
    )
    if (!('event' in result)) throw new Error('Expected committed terminal event')
    expect(result).toMatchObject({
      status: 'committed',
      article: {
        jobId: current.job.id,
        sourceRunId: current.claimed.run.id,
        topic: 'Durable terminal',
        revision: 0,
        graphVersion: execution.graphVersion,
      },
      event: {
        event: 'done',
        data: { output_path: null, article_id: expect.any(String), _seq: 1 },
      },
    })
    expect(await jobsRepository.getJob(current.job.id)).toMatchObject({
      status: 'completed',
      nextEventSeq: 2,
      leaseToken: null,
    })
    expect(await jobsRepository.getRun(current.claimed.run.id)).toMatchObject({
      status: 'completed',
    })
    expect(await jobsRepository.listEventsAfter(current.job.id)).toEqual([
      { event: 'stage_update', data: { stage: 'export', _seq: 0 } },
      result.event,
    ])
    expect(await db.select().from(outboxEvents)
      .where(eq(outboxEvents.aggregateType, 'memory_extraction'))).toHaveLength(0)
  })

  it('creates a Memory extraction request only when explicitly enabled', async () => {
    const current = await claim('terminal-memory-opt-in')
    await createTerminalRepository(db).completeClaim({
      ...completion(current.identity),
      requestMemoryExtraction: true,
    })
    expect(await db.select().from(outboxEvents)
      .where(eq(outboxEvents.aggregateType, 'memory_extraction'))).toMatchObject([{
      idempotencyKey: `run:${current.claimed.run.id}:memory-extraction:v2`,
      aggregateId: current.claimed.run.id,
      eventType: 'memory.extraction.requested',
      payload: {
        schemaVersion: 2,
        source: { kind: 'run', runId: current.claimed.run.id },
      },
      status: 'pending',
    }])
  })

  it('replays the same terminal commit and rejects a content collision', async () => {
    const current = await claim('terminal-replay')
    const repository = createTerminalRepository(db)
    const input = { ...completion(current.identity), requestMemoryExtraction: true }
    const first = await repository.completeClaim(input)
    if (!('article' in first)) throw new Error('Expected committed article')

    await expect(repository.completeClaim(input)).resolves.toMatchObject({
      status: 'replayed',
      article: { id: first.article.id },
      event: { data: { article_id: first.article.id, _seq: 0 } },
    })
    await expect(
      repository.completeClaim({ ...input, markdown: '# Different content' }),
    ).rejects.toThrow('Terminal idempotency collision')
    const [articleCount] = await db.select({ value: count() }).from(articles)
    const [eventCount] = await db.select({ value: count() }).from(jobEvents)
    expect(articleCount?.value).toBe(1)
    expect(eventCount?.value).toBe(1)
    expect(await db.select().from(outboxEvents)
      .where(eq(outboxEvents.aggregateType, 'memory_extraction'))).toHaveLength(1)
  })

  it('rejects an expired stale run and lets the takeover commit once', async () => {
    const first = await claim('terminal-takeover', 'worker-a')
    await db
      .update(jobs)
      .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(jobs.id, first.job.id))
    const second = await createJobRepository(db).claimJob({
      jobId: first.job.id,
      workerId: 'worker-b',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!second) throw new Error('Expected takeover')

    const repository = createTerminalRepository(db)
    await expect(repository.completeClaim(completion(first.identity))).resolves.toEqual({
      status: 'lease_lost',
    })
    const secondIdentity = {
      jobId: first.job.id,
      runId: second.run.id,
      leaseToken: second.leaseToken,
    }
    await expect(repository.completeClaim(completion(secondIdentity))).resolves.toMatchObject({
      status: 'committed',
      article: { sourceRunId: second.run.id },
    })
    const terminalRuns = await db
      .select()
      .from(runs)
      .where(eq(runs.jobId, first.job.id))
    expect(terminalRuns.map((run) => run.status)).toEqual(['failed', 'completed'])
  })

  it('honors cancellation before creating an article', async () => {
    const current = await claim('terminal-cancel')
    await createJobRepository(db).requestCancellation(current.job.id)
    await expect(
      createTerminalRepository(db).completeClaim(completion(current.identity)),
    ).resolves.toEqual({ status: 'cancel_requested' })
    const [articleCount] = await db.select({ value: count() }).from(articles)
    expect(articleCount?.value).toBe(0)
  })

  it.each([
    {
      outcome: 'failed' as const,
      input: {
        outcome: 'failed' as const,
        errorCode: 'workflow_failed',
        errorMessage: 'Workflow failed safely.',
      },
      event: { event: 'error', data: { message: 'Workflow failed safely.', _seq: 0 } },
    },
    {
      outcome: 'cancelled' as const,
      input: { outcome: 'cancelled' as const },
      event: { event: 'cancelled', data: { _seq: 0 } },
    },
  ])('atomically settles $outcome with its terminal event', async ({ outcome, input, event }) => {
    const current = await claim(`terminal-${outcome}`)
    const jobsRepository = createJobRepository(db)
    await jobsRepository.reserveRunEffect({
      ...current.identity,
      effectKey: `model:${outcome}:attempt:1`,
      effectType: 'model_call',
      requestFingerprint: `sha256:${'a'.repeat(64)}`,
      trace: { operation: `writer.${outcome}` },
    })
    if (outcome === 'cancelled') {
      await jobsRepository.requestCancellation(current.job.id)
    }
    const repository = createTerminalRepository(db)
    const terminalInput = { ...current.identity, ...input }
    await expect(repository.terminateClaim(terminalInput)).resolves.toMatchObject({
      status: 'settled',
      event,
    })
    await expect(repository.terminateClaim(terminalInput)).resolves.toMatchObject({
      status: 'replayed',
      event,
    })
    expect(await jobsRepository.getJob(current.job.id)).toMatchObject({
      status: outcome,
      nextEventSeq: 1,
      leaseToken: null,
    })
    expect(await jobsRepository.getRun(current.claimed.run.id)).toMatchObject({
      status: outcome,
    })
    expect(await db.select().from(schema.runEffects)
      .where(eq(schema.runEffects.runId, current.claimed.run.id))).toMatchObject([{
      status: 'uncertain',
      errorCode: 'run_terminal_with_reserved_effect',
    }])
    expect(await db.select().from(schema.traceSpans)
      .where(eq(schema.traceSpans.runId, current.claimed.run.id))).toMatchObject([{
      status: 'uncertain',
      errorCode: 'run_terminal_with_running_span',
    }])
    const [articleCount] = await db.select({ value: count() }).from(articles)
    expect(articleCount?.value).toBe(0)
  })

  it('projects an outline interrupt to awaiting_input and replays it safely', async () => {
    const current = await claim('terminal-awaiting-input')
    const repository = createTerminalRepository(db)
    const input = {
      ...current.identity,
      interruptId: 'interrupt-outline-1',
      outline: ['第一章', '第二章'],
    }
    await expect(repository.pauseClaim(input)).resolves.toMatchObject({
      status: 'paused',
      event: {
        event: 'outline_ready',
        data: { outline: ['第一章', '第二章'], _seq: 0 },
      },
    })
    await db
      .update(jobEvents)
      .set({ idempotencyKey: `job:${current.job.id}:awaiting:outline:v1` })
      .where(eq(jobEvents.jobId, current.job.id))
    await expect(repository.pauseClaim(input)).resolves.toMatchObject({
      status: 'replayed',
    })
    expect(await createJobRepository(db).getJob(current.job.id)).toMatchObject({
      status: 'awaiting_input',
      leaseToken: null,
      finishedAt: null,
    })
    expect(await createJobRepository(db).getRun(current.claimed.run.id)).toMatchObject({
      status: 'completed',
    })
  })
})
