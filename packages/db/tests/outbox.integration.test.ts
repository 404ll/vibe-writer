import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createJobRepository } from '../src/repositories/jobs'
import { createOutboxRepository } from '../src/repositories/outbox'
import * as schema from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'
import { outboxEvents } from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

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

async function createOutbox() {
  const { job } = await createJobRepository(db).createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: `outbox-${randomUUID()}`,
    topic: 'Outbox dispatch',
    intervention: { on_outline: true },
  })
  return job
}

describe('outbox repository', () => {
  it('keeps write and Eval dispatchers in separate aggregate lanes', async () => {
    const job = await createOutbox()
    const evalRunId = randomUUID()
    await db.insert(outboxEvents).values({
      idempotencyKey: `eval:${evalRunId}:enqueue:v1`,
      aggregateType: 'eval_run',
      aggregateId: evalRunId,
      eventType: 'eval.run.requested',
      payload: { evalRunId },
    })
    const repository = createOutboxRepository(db)
    const [write] = await repository.claimBatch({
      dispatcherId: 'write-dispatcher',
      aggregateType: 'job',
      limit: 10,
      lockTimeoutMs: 30_000,
    })
    const [evaluation] = await repository.claimBatch({
      dispatcherId: 'eval-dispatcher',
      aggregateType: 'eval_run',
      limit: 10,
      lockTimeoutMs: 30_000,
    })
    expect(write).toMatchObject({ aggregateType: 'job', aggregateId: job.id })
    expect(evaluation).toMatchObject({ aggregateType: 'eval_run', aggregateId: evalRunId })
  })

  it('claims a ready event once with a unique fencing token', async () => {
    const job = await createOutbox()
    const repository = createOutboxRepository(db)
    const [first, duplicate] = await Promise.all([
      repository.claimBatch({ dispatcherId: 'dispatcher-a', aggregateType: 'job', limit: 10, lockTimeoutMs: 30_000 }),
      repository.claimBatch({ dispatcherId: 'dispatcher-b', aggregateType: 'job', limit: 10, lockTimeoutMs: 30_000 }),
    ])

    expect([...first, ...duplicate]).toHaveLength(1)
    expect([...first, ...duplicate][0]).toMatchObject({
      aggregateId: job.id,
      eventType: 'job.enqueue.requested',
      status: 'publishing',
      attempts: 1,
    })
    expect([...first, ...duplicate][0]?.lockToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('reclaims a stale publishing row and fences the old token', async () => {
    await createOutbox()
    const repository = createOutboxRepository(db)
    const [first] = await repository.claimBatch({
      dispatcherId: 'dispatcher-a',
      aggregateType: 'job',
      limit: 1,
      lockTimeoutMs: 30_000,
    })
    if (!first) throw new Error('Expected first claim')
    await db
      .update(outboxEvents)
      .set({ lockedAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(outboxEvents.id, first.id))

    const [second] = await repository.claimBatch({
      dispatcherId: 'dispatcher-b',
      aggregateType: 'job',
      limit: 1,
      lockTimeoutMs: 30_000,
    })
    if (!second) throw new Error('Expected stale claim takeover')
    expect(second).toMatchObject({ lockedBy: 'dispatcher-b', attempts: 2 })
    expect(second.lockToken).not.toBe(first.lockToken)
    await expect(
      repository.markPublished({ eventId: first.id, lockToken: first.lockToken }),
    ).resolves.toBe('lease_lost')
    await expect(
      repository.releaseFailure({
        eventId: first.id,
        lockToken: first.lockToken,
        error: 'old dispatcher',
        retryAt: new Date(),
        terminal: false,
      }),
    ).resolves.toBe('lease_lost')
    await expect(
      repository.markPublished({ eventId: second.id, lockToken: second.lockToken }),
    ).resolves.toBe('published')
  })

  it('releases retryable failures and stops terminal failures', async () => {
    await createOutbox()
    const repository = createOutboxRepository(db)
    const [first] = await repository.claimBatch({
      dispatcherId: 'dispatcher-a',
      aggregateType: 'job',
      limit: 1,
      lockTimeoutMs: 30_000,
    })
    if (!first) throw new Error('Expected claim')
    const retryAt = new Date(Date.now() - 1_000)
    await expect(
      repository.releaseFailure({
        eventId: first.id,
        lockToken: first.lockToken,
        error: 'redis unavailable',
        retryAt,
        terminal: false,
      }),
    ).resolves.toBe('released')

    const [retried] = await repository.claimBatch({
      dispatcherId: 'dispatcher-b',
      aggregateType: 'job',
      limit: 1,
      lockTimeoutMs: 30_000,
    })
    if (!retried) throw new Error('Expected retry claim')
    expect(retried.attempts).toBe(2)
    await repository.releaseFailure({
      eventId: retried.id,
      lockToken: retried.lockToken,
      error: 'permanent publish failure',
      retryAt: new Date(),
      terminal: true,
    })
    await expect(
      repository.claimBatch({
        dispatcherId: 'dispatcher-c',
        aggregateType: 'job',
        limit: 1,
        lockTimeoutMs: 30_000,
      }),
    ).resolves.toEqual([])
  })
})
