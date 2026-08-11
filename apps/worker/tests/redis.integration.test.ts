import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import {
  createJobRepository,
  createMemoryExtractionRepository,
  createMemorySourceSignalRepository,
  createCommandRepository,
  createOutboxRepository,
  createTerminalRepository,
  createWorkspaceRepository,
  SYSTEM_PRINCIPAL_ID,
  SYSTEM_WORKSPACE_ID,
} from '@vibe-writer/db'
import * as schema from '@vibe-writer/db/schema'
import { Queue, Worker } from 'bullmq'
import { count, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BullMqWritePublisher,
  BullMqWriteWorker,
  BullMqMemoryPublisher,
  BullMqMemoryWorker,
  createWorkerLeaseControl,
  OutboxDispatcher,
  MemoryExtractionService,
  MemoryOutboxDispatcher,
  MEMORY_EXTRACTION_QUEUE_JOB_NAME,
  WRITE_QUEUE_JOB_NAME,
  processBullMqWriteJob,
  WorkerJobRunner,
  writeQueueJobId,
  type WriteQueueJobData,
  type MemoryExtractionQueueData,
  type WorkerRunResult,
} from '../src'

const redisUrl = process.env.TEST_REDIS_URL
const testId = process.env.VIBE_WRITER_REDIS_TEST_ID
if (!redisUrl || !testId || !/^[0-9a-f]{32}$/.test(testId)) {
  throw new Error('Harness-created Redis target is required')
}
const parsed = new URL(redisUrl)
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port) {
  throw new Error(`Refusing non-loopback Redis target ${parsed.host}`)
}
const connection = {
  host: parsed.hostname,
  port: Number(parsed.port),
  maxRetriesPerRequest: null,
}
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
)

const execution = {
  modelProfile: { profile: 'redis-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'redis-integration',
}

const closers: Array<() => Promise<unknown>> = []

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()))
})

async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

function scope() {
  const suffix = randomUUID()
  return {
    queueName: `write-${suffix}`,
    prefix: `vibe-writer-test-${testId}-${suffix}`,
  }
}

function completed(runId = randomUUID()): WorkerRunResult {
  return { status: 'completed', runId }
}

function observer() {
  return { error: vi.fn(), failed: vi.fn(), stalled: vi.fn() }
}

describe.sequential('BullMQ Redis integration', () => {
  it('deduplicates the same queue job id and executes it once', async () => {
    const names = scope()
    const jobId = randomUUID()
    const queueJobId = writeQueueJobId(jobId)
    const publisher = new BullMqWritePublisher({
      ...names,
      connection,
      defaultJobOptions: { attempts: 2, backoff: 10 },
    })
    const runner = { run: vi.fn(async () => completed()) }
    const worker = new BullMqWriteWorker(runner, {
      ...names,
      connection,
      workerName: 'worker-dedup',
      concurrency: 1,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    const queue = new Queue<WriteQueueJobData>(names.queueName, {
      connection,
      prefix: names.prefix,
    })
    closers.push(() => publisher.close(), () => worker.close(), () => queue.close())

    const data = { schemaVersion: 1 as const, jobId }
    await publisher.enqueue(WRITE_QUEUE_JOB_NAME, data, { jobId: queueJobId })
    await publisher.enqueue(WRITE_QUEUE_JOB_NAME, data, { jobId: queueJobId })
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 })

    await worker.start()
    await eventually(async () => {
      expect(await (await queue.getJob(queueJobId))?.getState()).toBe('completed')
    })
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('routes distinct duplicate deliveries through one database claim', async () => {
    const names = scope()
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const repository = createJobRepository(db)
    const { job } = await repository.createJob({
      workspaceId: SYSTEM_WORKSPACE_ID,
      createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
      idempotencyKey: `redis-db-${randomUUID()}`,
      topic: 'Duplicate delivery fencing',
      intervention: { on_outline: false },
    })
    const executor = {
      execute: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return {
          status: 'completed' as const,
          exportIntent: {
            idempotencyKey: `job:${job.id}:article:export`,
            markdown: '# Duplicate delivery fencing\n\nBody',
          },
        }
      }),
    }
    const runner = new WorkerJobRunner(
      createWorkerLeaseControl(repository, createTerminalRepository(db)),
      executor,
      {
      workerId: 'worker-db-claim',
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      execution,
      },
    )
    const worker = new BullMqWriteWorker(runner, {
      ...names,
      connection,
      workerName: 'worker-db-claim',
      concurrency: 2,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    const queue = new Queue<WriteQueueJobData>(names.queueName, {
      connection,
      prefix: names.prefix,
      defaultJobOptions: {
        attempts: 20,
        backoff: { type: 'fixed', delay: 25 },
      },
    })
    closers.push(() => worker.close(), () => queue.close(), () => client.close())

    const data = { schemaVersion: 1 as const, jobId: job.id }
    const first = await queue.add(WRITE_QUEUE_JOB_NAME, data, {
      jobId: `delivery-${randomUUID()}`,
    })
    const duplicate = await queue.add(WRITE_QUEUE_JOB_NAME, data, {
      jobId: `delivery-${randomUUID()}`,
    })
    await worker.start()
    await eventually(async () => {
      expect(await first.getState()).toBe('completed')
      expect(await duplicate.getState()).toBe('completed')
    })

    const [runCount] = await db
      .select({ value: count() })
      .from(schema.runs)
      .where(eq(schema.runs.jobId, job.id))
    expect(runCount?.value).toBe(1)
    const [articleCount] = await db
      .select({ value: count() })
      .from(schema.articles)
      .where(eq(schema.articles.jobId, job.id))
    const [eventCount] = await db
      .select({ value: count() })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, job.id))
    expect(articleCount?.value).toBe(1)
    expect(eventCount?.value).toBe(1)
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect((await repository.getJob(job.id))?.status).toBe('completed')
  })

  it('dispatches the transactional outbox through BullMQ into the database runner', async () => {
    const names = scope()
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const jobRepository = createJobRepository(db)
    const outboxRepository = createOutboxRepository(db)
    const { job } = await jobRepository.createJob({
      workspaceId: SYSTEM_WORKSPACE_ID,
      createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
      idempotencyKey: `redis-outbox-${randomUUID()}`,
      topic: 'Outbox to BullMQ',
      intervention: { on_outline: false },
    })
    const executor = {
      execute: vi.fn(async () => ({
        status: 'completed' as const,
        exportIntent: {
          idempotencyKey: `job:${job.id}:article:export`,
          markdown: '# Outbox to BullMQ\n\nBody',
        },
      })),
    }
    const runner = new WorkerJobRunner(
      createWorkerLeaseControl(jobRepository, createTerminalRepository(db)),
      executor,
      {
      workerId: 'worker-outbox-chain',
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      execution,
      },
    )
    const publisher = new BullMqWritePublisher({ ...names, connection })
    const dispatcher = new OutboxDispatcher(outboxRepository, publisher, {
      dispatcherId: 'dispatcher-chain',
      batchSize: 10,
      lockTimeoutMs: 30_000,
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
    })
    const worker = new BullMqWriteWorker(runner, {
      ...names,
      connection,
      workerName: 'worker-outbox-chain',
      concurrency: 1,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    const queue = new Queue<WriteQueueJobData>(names.queueName, {
      connection,
      prefix: names.prefix,
    })
    closers.push(
      () => publisher.close(),
      () => worker.close(),
      () => queue.close(),
      () => client.close(),
    )

    await expect(dispatcher.dispatchBatch()).resolves.toEqual([
      {
        eventId: expect.any(String),
        status: 'published',
        queueJobId: writeQueueJobId(job.id),
      },
    ])
    await worker.start()
    await eventually(async () => {
      expect(await (await queue.getJob(writeQueueJobId(job.id)))?.getState()).toBe(
        'completed',
      )
    })
    expect((await jobRepository.getJob(job.id))?.status).toBe('completed')
    expect(executor.execute).toHaveBeenCalledTimes(1)
    const [outbox] = await db.select().from(schema.outboxEvents)
    expect(outbox).toMatchObject({ status: 'published', lockedBy: null, lockToken: null })
  })

  it('dispatches typed run and signal Memory sources through a pointer-only queue', async () => {
    const names = scope()
    const memoryNames = { queueName: `memory-${randomUUID()}`, prefix: names.prefix }
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const jobs = createJobRepository(db)
    const { job } = await jobs.createJob({
      workspaceId: SYSTEM_WORKSPACE_ID,
      createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
      idempotencyKey: `redis-memory-${randomUUID()}`,
      topic: 'Redis Memory extraction',
      intervention: { on_outline: false },
    })
    const claim = await jobs.claimJob({
      jobId: job.id,
      workerId: 'redis-memory-source',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!claim) throw new Error('Expected Redis Memory source claim')
    const terminal = await createTerminalRepository(db).completeClaim({
      jobId: job.id,
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
      exportIdempotencyKey: `job:${job.id}:article:export`,
      topic: 'Redis Memory extraction',
      markdown: '# Redis Memory extraction\n\nPrefer concise prose.',
      outputPath: null,
    })
    if (!('article' in terminal)) throw new Error('Expected Redis Memory article')
    const service = new MemoryExtractionService(
      createMemoryExtractionRepository(db),
      {
        maxOutputTokens: 256,
        extract: vi.fn(async () => ({
          provider: 'scripted',
          model: 'redis-scripted-memory-v1',
          requestId: 'redis-scripted-memory-request-1',
          usage: { inputTokens: 100, outputTokens: 20 },
          output: {
            schemaVersion: 1 as const,
            candidates: [{
              subject: { kind: 'workspace' as const, key: 'default' },
              memoryKey: 'writing.tone',
              kind: 'preference' as const,
              content: 'Prefer concise prose.',
              confidence: 0.95,
              sensitivity: 'normal' as const,
            }],
          },
        })),
      },
      {
        extractorKey: 'redis-scripted-extractor',
        extractorVersion: 'v1',
        promptVersion: '2026-08-07-v1',
        consentPolicyVersion: 'redis-memory-consent-v1',
        retentionDays: 30,
        modelProfile: {
          profile: 'redis-scripted-memory',
          provider: 'scripted',
          model: 'redis-scripted-memory-v1',
        },
        workerId: 'redis-memory-worker',
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        maxAttempts: 3,
        budget: {
          policyVersion: 'redis-memory-budget-v1',
          maxSourceCostMicrousd: 10_000,
          maxWorkspaceDailyCostMicrousd: 100_000,
          maxOutputTokens: 256,
          pricing: {
            version: 'redis-memory-pricing-v1',
            inputMicrousdPerMillionTokens: 10_000,
            outputMicrousdPerMillionTokens: 20_000,
            cacheReadMicrousdPerMillionTokens: 1_000,
            cacheWriteMicrousdPerMillionTokens: 12_500,
          },
        },
      },
    )
    const publisher = new BullMqMemoryPublisher({ ...memoryNames, connection })
    const dispatcher = new MemoryOutboxDispatcher(
      createOutboxRepository(db),
      publisher,
      {
        dispatcherId: 'redis-memory-dispatcher',
        batchSize: 10,
        lockTimeoutMs: 30_000,
        maxAttempts: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
      },
    )
    const worker = new BullMqMemoryWorker(service, {
      ...memoryNames,
      connection,
      workerName: 'redis-memory-worker',
      concurrency: 1,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    const queue = new Queue<MemoryExtractionQueueData>(memoryNames.queueName, {
      connection,
      prefix: memoryNames.prefix,
    })
    closers.push(
      () => publisher.close(),
      () => worker.close(),
      () => queue.close(),
      () => client.close(),
    )

    await expect(dispatcher.dispatchBatch()).resolves.toMatchObject([{
      status: 'published',
      queueJobId: `memory-run-${claim.run.id}`,
    }])
    const queued = await queue.getJob(`memory-run-${claim.run.id}`)
    expect(queued).toMatchObject({
      name: MEMORY_EXTRACTION_QUEUE_JOB_NAME,
      data: {
        schemaVersion: 2,
        source: { kind: 'run', runId: claim.run.id },
      },
    })
    expect(JSON.stringify(queued?.data)).not.toContain('concise prose')
    await worker.start()
    await eventually(async () => {
      expect(await queued?.getState()).toBe('completed')
    })
    expect(await db.select().from(schema.memoryCandidates)).toMatchObject([{
      sourceRunId: claim.run.id,
      memoryKey: 'writing.tone',
      status: 'pending_review',
    }])
    expect(await db.select().from(schema.memories)).toEqual([])
    expect(await db.select().from(schema.memoryExtractionEffects)).toMatchObject([{
      status: 'succeeded',
      costMicrousd: 2,
      pricingVersion: 'redis-memory-pricing-v1',
      reservedCostMicrousd: expect.any(Number),
    }])

    const owner = await createWorkspaceRepository(db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `redis-memory-signal-${randomUUID().slice(0, 8)}`,
      name: 'Redis Memory signal',
    })
    const created = await createMemorySourceSignalRepository(db).create(owner, {
      idempotencyKey: `redis-memory-signal-${randomUUID()}`,
      sourceKind: 'explicit_remember',
      subject: { kind: 'principal', key: owner.principalId },
      text: 'This private signal must never enter Redis.',
      consentPolicyVersion: 'redis-memory-consent-v1',
      retentionDays: 30,
    })
    await expect(dispatcher.dispatchBatch()).resolves.toMatchObject([{
      status: 'published',
      queueJobId: `memory-signal-${created.signal.id}`,
    }])
    const signalQueued = await queue.getJob(`memory-signal-${created.signal.id}`)
    expect(signalQueued).toMatchObject({
      name: MEMORY_EXTRACTION_QUEUE_JOB_NAME,
      data: {
        schemaVersion: 2,
        source: { kind: 'signal', signalId: created.signal.id },
      },
    })
    expect(JSON.stringify(signalQueued?.data)).not.toContain('private signal')
    await eventually(async () => {
      expect(await signalQueued?.getState()).toBe('completed')
    })
    expect(await db.select().from(schema.memoryCandidates)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: 'signal',
        sourceSignalId: created.signal.id,
        subjectKind: 'principal',
        subjectKey: owner.principalId,
        consentBasis: 'explicit_user',
      }),
    ]))
  }, 10_000)

  it('dispatches a durable outline reply through resume outbox and a second claim', async () => {
    const names = scope()
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const jobs = createJobRepository(db)
    const terminals = createTerminalRepository(db)
    const commands = createCommandRepository(db)
    const outbox = createOutboxRepository(db)
    const { job } = await jobs.createJob({
      workspaceId: SYSTEM_WORKSPACE_ID,
      createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
      idempotencyKey: `redis-resume-${randomUUID()}`,
      topic: 'Redis durable resume',
      intervention: { on_outline: true },
    })
    const executor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'awaiting_input' as const,
          interruptId: 'redis-outline-interrupt',
          outline: ['第一章'],
        })
        .mockResolvedValueOnce({
          status: 'completed' as const,
          exportIntent: {
            idempotencyKey: `job:${job.id}:article:export`,
            markdown: '# Redis durable resume\n\nBody',
          },
        }),
    }
    const runner = new WorkerJobRunner(
      createWorkerLeaseControl(jobs, terminals),
      executor,
      {
        workerId: 'worker-redis-resume',
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 100,
        execution,
      },
    )
    const publisher = new BullMqWritePublisher({ ...names, connection })
    const dispatcher = new OutboxDispatcher(outbox, publisher, {
      dispatcherId: 'dispatcher-resume',
      batchSize: 10,
      lockTimeoutMs: 30_000,
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
    })
    const worker = new BullMqWriteWorker(runner, {
      ...names,
      connection,
      workerName: 'worker-redis-resume',
      concurrency: 1,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    closers.push(() => publisher.close(), () => worker.close(), () => client.close())

    await expect(dispatcher.dispatchBatch()).resolves.toMatchObject([
      { status: 'published', queueJobId: writeQueueJobId(job.id) },
    ])
    await worker.start()
    await eventually(async () => {
      expect((await jobs.getJob(job.id))?.status).toBe('awaiting_input')
    })
    await expect(
      commands.submitOutlineReply({
        jobId: job.id,
        reply: { message: '确认', outline: ['第一章'] },
      }),
    ).resolves.toMatchObject({ status: 'queued' })
    await expect(dispatcher.dispatchBatch()).resolves.toMatchObject([
      { status: 'published', queueJobId: expect.stringMatching(/^resume-/) },
    ])
    await eventually(async () => {
      expect((await jobs.getJob(job.id))?.status).toBe('completed')
    })
    expect(executor.execute).toHaveBeenCalledTimes(2)
    const [articleCount] = await db
      .select({ value: count() })
      .from(schema.articles)
      .where(eq(schema.articles.jobId, job.id))
    expect(articleCount?.value).toBe(1)
    expect((await jobs.listEventsAfter(job.id)).map((event) => event.event)).toEqual([
      'outline_ready',
      'done',
    ])
  })

  it('retries lease loss but fails an invalid envelope without retrying', async () => {
    const names = scope()
    const validJobId = randomUUID()
    const runner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ status: 'lease_lost', runId: randomUUID() })
        .mockResolvedValueOnce(completed()),
    }
    const worker = new BullMqWriteWorker(runner, {
      ...names,
      connection,
      workerName: 'worker-retry',
      concurrency: 1,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    const queue = new Queue<WriteQueueJobData>(names.queueName, {
      connection,
      prefix: names.prefix,
      defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
    })
    closers.push(() => worker.close(), () => queue.close())

    const valid = await queue.add(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId: validJobId },
      { jobId: writeQueueJobId(validJobId) },
    )
    const invalid = await queue.add(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 2, jobId: randomUUID() } as never,
      { jobId: `invalid-${randomUUID()}`, attempts: 5 },
    )
    await worker.start()

    await eventually(async () => {
      expect(await valid.getState()).toBe('completed')
      expect(await invalid.getState()).toBe('failed')
    })
    expect(runner.run).toHaveBeenCalledTimes(2)
    expect((await queue.getJob(invalid.id!))?.attemptsMade).toBe(1)
  })

  it('propagates database cancellation through heartbeat and acknowledges delivery', async () => {
    const names = scope()
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const repository = createJobRepository(db)
    const { job: durableJob } = await repository.createJob({
      workspaceId: SYSTEM_WORKSPACE_ID,
      createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
      idempotencyKey: `redis-cancel-${randomUUID()}`,
      topic: 'Cancellation delivery',
      intervention: { on_outline: false },
    })
    const executor = {
      execute: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            )
          }),
      ),
    }
    const runner = new WorkerJobRunner(
      createWorkerLeaseControl(repository, createTerminalRepository(db)),
      executor,
      {
      workerId: 'worker-cancel-db',
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 50,
      execution,
      },
    )
    const worker = new BullMqWriteWorker(runner, {
      ...names,
      connection,
      workerName: 'worker-cancel-db',
      concurrency: 1,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    const queue = new Queue<WriteQueueJobData>(names.queueName, {
      connection,
      prefix: names.prefix,
    })
    closers.push(() => worker.close(), () => queue.close(), () => client.close())

    const queued = await queue.add(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId: durableJob.id },
      { jobId: writeQueueJobId(durableJob.id) },
    )
    await worker.start()
    await eventually(async () => {
      expect((await repository.getJob(durableJob.id))?.status).toBe('running')
    })
    await expect(repository.requestCancellation(durableJob.id)).resolves.toBe(
      'cancel_requested',
    )
    await eventually(async () => {
      expect(await queued.getState()).toBe('completed')
      expect((await repository.getJob(durableJob.id))?.status).toBe('cancelled')
    })
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('redelivers a stalled job and still enters through the database runner', async () => {
    const names = scope()
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const repository = createJobRepository(db)
    const { job: durableJob } = await repository.createJob({
      workspaceId: SYSTEM_WORKSPACE_ID,
      createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
      idempotencyKey: `redis-stalled-${randomUUID()}`,
      topic: 'Stalled DB fencing',
      intervention: { on_outline: false },
    })
    const executor = {
      execute: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 350))
        return {
          status: 'completed' as const,
          exportIntent: {
            idempotencyKey: `job:${durableJob.id}:article:export`,
            markdown: '# Stalled DB fencing\n\nBody',
          },
        }
      }),
    }
    const runner = new WorkerJobRunner(
      createWorkerLeaseControl(repository, createTerminalRepository(db)),
      executor,
      {
      workerId: 'worker-stalled-db',
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 100,
      execution,
      },
    )
    const runSpy = vi.spyOn(runner, 'run')
    const stalled: string[] = []
    const worker = new Worker<WriteQueueJobData, WorkerRunResult>(
      names.queueName,
      (job) => processBullMqWriteJob(job, runner),
      {
        connection,
        prefix: names.prefix,
        concurrency: 2,
        lockDuration: 100,
        stalledInterval: 100,
        maxStalledCount: 1,
        skipLockRenewal: true,
      },
    )
    worker.on('stalled', (id) => stalled.push(id))
    const queue = new Queue<WriteQueueJobData>(names.queueName, {
      connection,
      prefix: names.prefix,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'fixed', delay: 200 },
      },
    })
    closers.push(() => worker.close(true), () => queue.close(), () => client.close())

    const job = await queue.add(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId: durableJob.id },
      { jobId: writeQueueJobId(durableJob.id) },
    )
    await eventually(async () => {
      expect(await job.getState()).toBe('completed')
    })
    expect(runSpy).toHaveBeenCalledTimes(3)
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect((await repository.getJob(durableJob.id))?.status).toBe('completed')
    const [runCount] = await db
      .select({ value: count() })
      .from(schema.runs)
      .where(eq(schema.runs.jobId, durableJob.id))
    expect(runCount?.value).toBe(1)
    const [articleCount] = await db
      .select({ value: count() })
      .from(schema.articles)
      .where(eq(schema.articles.jobId, durableJob.id))
    const [eventCount] = await db
      .select({ value: count() })
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, durableJob.id))
    expect(articleCount?.value).toBe(1)
    expect(eventCount?.value).toBe(1)
    expect(stalled).toEqual([job.id])
  })

  it('graceful close waits for the active job and does not take the next one', async () => {
    const names = scope()
    let finish!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const runner = {
      run: vi.fn(
        () =>
          new Promise<WorkerRunResult>((resolve) => {
            started()
            finish = () => resolve(completed())
          }),
      ),
    }
    const worker = new BullMqWriteWorker(runner, {
      ...names,
      connection,
      workerName: 'worker-shutdown',
      concurrency: 1,
      lockDurationMs: 1_000,
      stalledIntervalMs: 200,
      observer: observer(),
    })
    const queue = new Queue<WriteQueueJobData>(names.queueName, {
      connection,
      prefix: names.prefix,
    })
    closers.push(() => queue.close())

    const firstId = randomUUID()
    const secondId = randomUUID()
    await queue.add(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId: firstId },
      { jobId: writeQueueJobId(firstId) },
    )
    const second = await queue.add(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId: secondId },
      { jobId: writeQueueJobId(secondId) },
    )
    await worker.start()
    await startedPromise
    const closing = worker.close()
    finish()
    await closing

    expect(runner.run).toHaveBeenCalledTimes(1)
    expect(await second.getState()).toBe('waiting')
  })
})
