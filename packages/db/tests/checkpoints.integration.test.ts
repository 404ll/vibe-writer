import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createCheckpointRepository } from '../src/repositories/checkpoints'
import { createJobRepository, type RunExecutionSnapshot } from '../src/repositories/jobs'
import * as schema from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'
import { checkpointAttempts, jobs } from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

let client: PGlite
let db: PgliteDatabase<typeof schema>

const execution = {
  modelProfile: { profile: 'test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'test-revision',
} satisfies RunExecutionSnapshot

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

async function claim(
  idempotencyKey: string,
  workerId: string,
  runExecution: RunExecutionSnapshot = execution,
) {
  const jobsRepository = createJobRepository(db)
  const { job } = await jobsRepository.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey,
    topic: 'Checkpoint isolation',
    intervention: { on_outline: true },
  })
  const claimed = await jobsRepository.claimJob({
    jobId: job.id,
    workerId,
    leaseDurationMs: 30_000,
    execution: runExecution,
  })
  if (!claimed) throw new Error(`Expected ${job.id} to be claimed`)
  return {
    job,
    claim: claimed,
    identity: {
      jobId: job.id,
      runId: claimed.run.id,
      leaseToken: claimed.leaseToken,
    },
  }
}

async function takeover(
  jobId: string,
  workerId: string,
  runExecution: RunExecutionSnapshot = execution,
) {
  await db
    .update(jobs)
    .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
    .where(eq(jobs.id, jobId))
  const claimed = await createJobRepository(db).claimJob({
    jobId,
    workerId,
    leaseDurationMs: 30_000,
    execution: runExecution,
  })
  if (!claimed) throw new Error(`Expected ${jobId} to be reclaimed`)
  return {
    claim: claimed,
    identity: {
      jobId,
      runId: claimed.run.id,
      leaseToken: claimed.leaseToken,
    },
  }
}

describe('checkpoint attempt repository', () => {
  it('prepares and activates one empty attempt idempotently', async () => {
    const { identity } = await claim('checkpoint-first', 'worker-a')
    const repository = createCheckpointRepository(db)

    const prepared = await repository.prepareCheckpointAttempt(identity)
    expect(prepared).toMatchObject({
      status: 'prepared',
      attempt: {
        runId: identity.runId,
        status: 'preparing',
        rootCheckpointNamespace: '',
        latestCheckpointId: null,
      },
    })
    if (prepared.status !== 'prepared') throw new Error('Expected prepared attempt')
    expect(prepared.attempt.checkpointThreadId).toBe(
      `job:${identity.jobId}:run:${identity.runId}`,
    )
    await expect(repository.prepareCheckpointAttempt(identity)).resolves.toMatchObject({
      status: 'existing',
      attempt: { id: prepared.attempt.id },
    })

    const activated = await repository.activateCheckpointAttempt(
      identity,
      prepared.attempt.id,
      null,
    )
    expect(activated).toMatchObject({ status: 'activated', attempt: { status: 'active' } })
    await expect(
      repository.activateCheckpointAttempt(identity, prepared.attempt.id, null),
    ).resolves.toMatchObject({ status: 'replayed' })
    await expect(
      repository.authorizeCheckpointWrite(
        identity,
        prepared.attempt.checkpointThreadId,
      ),
    ).resolves.toBe('authorized')
  })

  it('advances only the active root pointer without regressing it', async () => {
    const { identity } = await claim('checkpoint-pointer', 'worker-a')
    const repository = createCheckpointRepository(db)
    const prepared = await repository.prepareCheckpointAttempt(identity)
    if (prepared.status !== 'prepared') throw new Error('Expected prepared attempt')
    await repository.activateCheckpointAttempt(identity, prepared.attempt.id, null)

    await expect(
      repository.advanceCheckpointPointer(
        identity,
        prepared.attempt.checkpointThreadId,
        '',
        'checkpoint-002',
      ),
    ).resolves.toMatchObject({ status: 'advanced' })
    await expect(
      repository.advanceCheckpointPointer(
        identity,
        prepared.attempt.checkpointThreadId,
        '',
        'checkpoint-002',
      ),
    ).resolves.toMatchObject({ status: 'replayed' })
    await expect(
      repository.advanceCheckpointPointer(
        identity,
        prepared.attempt.checkpointThreadId,
        '',
        'checkpoint-001',
      ),
    ).resolves.toEqual({ status: 'stale_checkpoint' })
    await expect(
      repository.advanceCheckpointPointer(
        identity,
        prepared.attempt.checkpointThreadId,
        'subgraph',
        'checkpoint-003',
      ),
    ).rejects.toThrow('Only the root checkpoint namespace')
  })

  it('forks the stable pointer into a new attempt and fences the stale run', async () => {
    const first = await claim('checkpoint-takeover', 'worker-a')
    const repository = createCheckpointRepository(db)
    const firstPrepared = await repository.prepareCheckpointAttempt(first.identity)
    if (firstPrepared.status !== 'prepared') throw new Error('Expected first attempt')
    await repository.activateCheckpointAttempt(first.identity, firstPrepared.attempt.id, null)
    await repository.advanceCheckpointPointer(
      first.identity,
      firstPrepared.attempt.checkpointThreadId,
      '',
      'checkpoint-stable',
    )

    const second = await takeover(first.job.id, 'worker-b')
    await expect(
      repository.authorizeCheckpointWrite(
        first.identity,
        firstPrepared.attempt.checkpointThreadId,
      ),
    ).resolves.toBe('lease_lost')
    const secondPrepared = await repository.prepareCheckpointAttempt(second.identity)
    expect(secondPrepared).toMatchObject({
      status: 'prepared',
      attempt: {
        forkedFromRunId: first.identity.runId,
        forkedFromCheckpointThreadId: firstPrepared.attempt.checkpointThreadId,
        forkedFromCheckpointNamespace: '',
        forkedFromCheckpointId: 'checkpoint-stable',
      },
    })
    if (secondPrepared.status !== 'prepared') throw new Error('Expected second attempt')
    await expect(
      repository.activateCheckpointAttempt(
        second.identity,
        secondPrepared.attempt.id,
        'wrong-checkpoint',
      ),
    ).resolves.toEqual({ status: 'invalid_fork' })
    await expect(
      repository.activateCheckpointAttempt(
        second.identity,
        secondPrepared.attempt.id,
        'checkpoint-stable',
      ),
    ).resolves.toMatchObject({ status: 'activated' })

    const rows = await db
      .select()
      .from(checkpointAttempts)
      .where(eq(checkpointAttempts.jobId, first.job.id))
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.runId === first.identity.runId)?.status).toBe(
      'superseded',
    )
    expect(rows.find((row) => row.runId === second.identity.runId)).toMatchObject({
      status: 'active',
      latestCheckpointId: 'checkpoint-stable',
    })
    await expect(
      repository.advanceCheckpointPointer(
        first.identity,
        firstPrepared.attempt.checkpointThreadId,
        '',
        'checkpoint-zombie',
      ),
    ).resolves.toEqual({ status: 'lease_lost' })
  })

  it('refuses to fork a stable checkpoint across graph versions', async () => {
    const first = await claim('checkpoint-version', 'worker-a')
    const repository = createCheckpointRepository(db)
    const prepared = await repository.prepareCheckpointAttempt(first.identity)
    if (prepared.status !== 'prepared') throw new Error('Expected first attempt')
    await repository.activateCheckpointAttempt(first.identity, prepared.attempt.id, null)
    await repository.advanceCheckpointPointer(
      first.identity,
      prepared.attempt.checkpointThreadId,
      '',
      'checkpoint-versioned',
    )

    const second = await takeover(first.job.id, 'worker-b', {
      ...execution,
      graphVersion: 'writer-graph-v2-incompatible',
      codeRevision: randomUUID(),
    })
    await expect(repository.prepareCheckpointAttempt(second.identity)).resolves.toEqual({
      status: 'incompatible_graph',
      sourceGraphVersion: execution.graphVersion,
      targetGraphVersion: 'writer-graph-v2-incompatible',
    })
    expect(await repository.getCheckpointAttempt(second.identity.runId)).toBeNull()
  })
})
