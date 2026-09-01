import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { count, eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createCommandRepository } from '../src/repositories/commands'
import { createJobRepository, type RunExecutionSnapshot } from '../src/repositories/jobs'
import { createTerminalRepository } from '../src/repositories/terminals'
import * as schema from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
let client: PGlite
let db: PgliteDatabase<typeof schema>

const execution = {
  modelProfile: { profile: 'command-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-v1' },
  codeRevision: 'command-test-revision',
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

async function awaitingJob() {
  const jobs = createJobRepository(db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: randomUUID(),
    topic: 'Durable reply',
    intervention: { on_outline: true },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: 'worker-command',
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claim) throw new Error('Expected claim')
  const interruptId = `interrupt-${randomUUID()}`
  await createTerminalRepository(db).pauseClaim({
    jobId: job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    interruptId,
    outline: ['第一章'],
  })
  return { job, claim, interruptId }
}

describe('durable command repository', () => {
  it('atomically stores a reply, requeues the job and writes resume outbox', async () => {
    const current = await awaitingJob()
    const repository = createCommandRepository(db)
    const reply = { message: '确认', outline: ['第一章'] }

    const result = await repository.submitOutlineReply({
      jobId: current.job.id,
      reply,
    })
    expect(result).toMatchObject({
      status: 'queued',
      interrupt: {
        externalId: current.interruptId,
        status: 'replied',
        repliedAt: expect.any(Date),
      },
      command: { payload: reply },
    })
    expect(await createJobRepository(db).getJob(current.job.id)).toMatchObject({
      status: 'queued',
      leaseToken: null,
    })
    expect(
      await repository.getOutlineReply(current.job.id, current.interruptId),
    ).toEqual(reply)
    const outbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, current.job.id))
      .orderBy(schema.outboxEvents.createdAt)
    expect(outbox.map((event) => event.eventType)).toEqual([
      'job.enqueue.requested',
      'job.resume.requested',
    ])
  })

  it('replays the same reply and rejects a different payload', async () => {
    const current = await awaitingJob()
    const repository = createCommandRepository(db)
    const input = {
      jobId: current.job.id,
      reply: { message: '确认', outline: ['第一章'] },
    }
    await expect(repository.submitOutlineReply(input)).resolves.toMatchObject({
      status: 'queued',
    })
    await expect(repository.submitOutlineReply(input)).resolves.toMatchObject({
      status: 'replayed',
    })
    await expect(
      repository.submitOutlineReply({
        jobId: current.job.id,
        reply: { message: '请改写', outline: ['另一章'] },
      }),
    ).rejects.toThrow('Reply idempotency collision')
    const [commandCount] = await db
      .select({ value: count() })
      .from(schema.jobCommands)
    const resumeOutbox = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, 'job.resume.requested'))
    expect(commandCount?.value).toBe(1)
    expect(resumeOutbox).toHaveLength(1)
  })

  it('persists a revised outline as a new review round', async () => {
    const current = await awaitingJob()
    const commands = createCommandRepository(db)
    const jobs = createJobRepository(db)

    await expect(commands.submitOutlineReply({
      jobId: current.job.id,
      reply: { message: '标题更幽默一些' },
    })).resolves.toMatchObject({ status: 'queued' })

    const resumed = await jobs.claimJob({
      jobId: current.job.id,
      workerId: 'worker-command-resume',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!resumed) throw new Error('Expected resumed claim')

    await expect(createTerminalRepository(db).pauseClaim({
      jobId: current.job.id,
      runId: resumed.run.id,
      leaseToken: resumed.leaseToken,
      interruptId: `interrupt-${randomUUID()}`,
      outline: ['修改后的第一章'],
    })).resolves.toMatchObject({
      status: 'paused',
      event: {
        event: 'outline_ready',
        data: { outline: ['修改后的第一章'], _seq: 1 },
      },
    })

    expect(await jobs.listEventsAfter(current.job.id)).toEqual([
      { event: 'outline_ready', data: { outline: ['第一章'], _seq: 0 } },
      { event: 'outline_ready', data: { outline: ['修改后的第一章'], _seq: 1 } },
    ])
    expect(await jobs.getJob(current.job.id)).toMatchObject({
      status: 'awaiting_input',
      nextEventSeq: 2,
      leaseToken: null,
    })
    expect((await db.select().from(schema.runs)
      .where(eq(schema.runs.jobId, current.job.id))).map((run) => run.status)).toEqual([
      'completed',
      'completed',
    ])
  })

  it('rejects a reply before the job is awaiting input', async () => {
    const { job } = await createJobRepository(db).createJob({
      workspaceId: SYSTEM_WORKSPACE_ID,
      createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
      idempotencyKey: randomUUID(),
      topic: 'Not waiting',
      intervention: { on_outline: true },
    })
    await expect(
      createCommandRepository(db).submitOutlineReply({
        jobId: job.id,
        reply: { message: '确认' },
      }),
    ).resolves.toEqual({ status: 'not_awaiting_input' })
  })

  it('cancels a pending interrupt with a durable terminal event', async () => {
    const current = await awaitingJob()
    const jobs = createJobRepository(db)
    await expect(jobs.requestCancellation(current.job.id)).resolves.toBe('cancelled')
    expect(await jobs.getJob(current.job.id)).toMatchObject({
      status: 'cancelled',
      nextEventSeq: 2,
    })
    expect((await jobs.listEventsAfter(current.job.id)).map((event) => event.event)).toEqual([
      'outline_ready',
      'cancelled',
    ])
    const [interrupt] = await db
      .select()
      .from(schema.jobInterrupts)
      .where(eq(schema.jobInterrupts.jobId, current.job.id))
    expect(interrupt?.status).toBe('cancelled')
  })
})
