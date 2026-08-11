import { randomUUID } from 'node:crypto'
import type { ClaimedOutboxEvent } from '@vibe-writer/db'
import { UnrecoverableError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import {
  OutboxDispatcher,
  DEFAULT_WRITE_JOB_OPTIONS,
  RetryableQueueDeliveryError,
  UnrecoverableQueueMessageError,
  WRITE_QUEUE_JOB_NAME,
  processWriteQueueJob,
  processBullMqWriteJob,
  writeQueueJobId,
  type OutboxDispatchControl,
  type WriteJobPublisher,
  type WorkerRunResult,
} from '../src'

const jobId = 'b54d9b33-3b9e-4b21-927b-24f402e6fe9b'

function event(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  const now = new Date('2026-08-07T00:00:00.000Z')
  return {
    id: randomUUID(),
    idempotencyKey: `job:${jobId}:enqueue:v1`,
    aggregateType: 'job',
    aggregateId: jobId,
    eventType: 'job.enqueue.requested',
    payload: { jobId },
    status: 'publishing',
    attempts: 1,
    availableAt: now,
    lockedBy: 'dispatcher-a',
    lockToken: randomUUID(),
    lockedAt: now,
    publishedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function control(events: ClaimedOutboxEvent[]) {
  return {
    claimBatch: vi.fn(async () => events),
    markPublished: vi.fn<OutboxDispatchControl['markPublished']>(
      async () => 'published',
    ),
    releaseFailure: vi.fn<OutboxDispatchControl['releaseFailure']>(
      async () => 'released',
    ),
  } satisfies OutboxDispatchControl
}

function publisher(): WriteJobPublisher {
  return { enqueue: vi.fn(async () => undefined) }
}

function dispatcher(
  dispatchControl: OutboxDispatchControl,
  writePublisher: WriteJobPublisher,
) {
  return new OutboxDispatcher(dispatchControl, writePublisher, {
    dispatcherId: 'dispatcher-a',
    batchSize: 10,
    lockTimeoutMs: 30_000,
    maxAttempts: 3,
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    now: () => new Date('2026-08-07T00:00:00.000Z'),
  })
}

describe('OutboxDispatcher', () => {
  it('publishes only the versioned job pointer with a deterministic queue id', async () => {
    const claimed = event()
    const dispatchControl = control([claimed])
    const writePublisher = publisher()

    await expect(dispatcher(dispatchControl, writePublisher).dispatchBatch()).resolves.toEqual([
      {
        eventId: claimed.id,
        status: 'published',
        queueJobId: `write-${jobId}`,
      },
    ])
    expect(writePublisher.enqueue).toHaveBeenCalledWith(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId },
      { jobId: `write-${jobId}` },
    )
    expect(dispatchControl.markPublished).toHaveBeenCalledWith({
      eventId: claimed.id,
      lockToken: claimed.lockToken,
    })
  })

  it('publishes a resume request through the same minimal queue envelope', async () => {
    const claimed = event({
      idempotencyKey: `job:${jobId}:resume:interrupt-1:v1`,
      eventType: 'job.resume.requested',
    })
    const writePublisher = publisher()
    await expect(
      dispatcher(control([claimed]), writePublisher).dispatchBatch(),
    ).resolves.toMatchObject([
      { status: 'published', queueJobId: `resume-${claimed.id}` },
    ])
    expect(writePublisher.enqueue).toHaveBeenCalledWith(
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId },
      { jobId: `resume-${claimed.id}` },
    )
  })

  it('releases a transient publish failure with bounded exponential backoff', async () => {
    const claimed = event({ attempts: 2 })
    const dispatchControl = control([claimed])
    const writePublisher = {
      enqueue: vi.fn(async () => {
        throw new Error('redis unavailable')
      }),
    }

    await expect(dispatcher(dispatchControl, writePublisher).dispatchBatch()).resolves.toEqual([
      { eventId: claimed.id, status: 'retry_scheduled' },
    ])
    expect(dispatchControl.releaseFailure).toHaveBeenCalledWith({
      eventId: claimed.id,
      lockToken: claimed.lockToken,
      error: 'redis unavailable',
      retryAt: new Date('2026-08-07T00:00:02.000Z'),
      terminal: false,
    })
  })

  it('marks invalid or exhausted events terminal without publishing content', async () => {
    const invalid = event({ payload: { jobId, topic: 'must not enter Redis' } })
    const exhausted = event({ attempts: 3 })
    const dispatchControl = control([invalid, exhausted])
    const writePublisher = publisher()
    vi.mocked(writePublisher.enqueue).mockRejectedValueOnce(new Error('redis unavailable'))

    await expect(dispatcher(dispatchControl, writePublisher).dispatchBatch()).resolves.toEqual([
      { eventId: invalid.id, status: 'failed' },
      { eventId: exhausted.id, status: 'failed' },
    ])
    expect(writePublisher.enqueue).toHaveBeenCalledTimes(1)
    expect(dispatchControl.releaseFailure).toHaveBeenCalledTimes(2)
  })

  it('does not mark a publish after its outbox token was fenced', async () => {
    const claimed = event()
    const dispatchControl = control([claimed])
    vi.mocked(dispatchControl.markPublished).mockResolvedValue('lease_lost')

    await expect(
      dispatcher(dispatchControl, publisher()).dispatchBatch(),
    ).resolves.toEqual([{ eventId: claimed.id, status: 'lease_lost' }])
  })

  it('reuses the same queue id after publish succeeds but mark is fenced', async () => {
    const first = event()
    const second = event({ id: first.id, attempts: 2 })
    const dispatchControl = control([first])
    vi.mocked(dispatchControl.claimBatch)
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second])
    vi.mocked(dispatchControl.markPublished)
      .mockResolvedValueOnce('lease_lost')
      .mockResolvedValueOnce('published')
    const writePublisher = publisher()
    const instance = dispatcher(dispatchControl, writePublisher)

    await instance.dispatchBatch()
    await instance.dispatchBatch()
    expect(writePublisher.enqueue).toHaveBeenCalledTimes(2)
    expect(writePublisher.enqueue).toHaveBeenNthCalledWith(
      1,
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId },
      { jobId: `write-${jobId}` },
    )
    expect(writePublisher.enqueue).toHaveBeenNthCalledWith(
      2,
      WRITE_QUEUE_JOB_NAME,
      { schemaVersion: 1, jobId },
      { jobId: `write-${jobId}` },
    )
  })
})

describe('write queue processor protocol', () => {
  it.each(['completed', 'awaiting_input', 'failed', 'cancelled'] as const)(
    'acks the database result %s',
    async (status) => {
      const result: WorkerRunResult =
        status === 'completed' || status === 'awaiting_input'
          ? { status, runId: 'run-1' }
          : status === 'failed'
            ? { status, runId: 'run-1', errorCode: 'execution_failed' }
            : { status, runId: 'run-1' }
      const runner = { run: vi.fn(async () => result) }
      await expect(
        processWriteQueueJob(
          { name: WRITE_QUEUE_JOB_NAME, data: { schemaVersion: 1, jobId } },
          runner,
        ),
      ).resolves.toEqual(result)
    },
  )

  it.each(['terminal', 'awaiting_input', 'not_found'] as const)(
    'acks a non-busy unclaimed delivery: %s',
    async (reason) => {
      const result = { status: 'not_claimed' as const, reason }
      await expect(
        processWriteQueueJob(
          { name: WRITE_QUEUE_JOB_NAME, data: { schemaVersion: 1, jobId } },
          { run: vi.fn(async () => result) },
        ),
      ).resolves.toEqual(result)
    },
  )

  it('retries lease loss and rejects an invalid payload as unrecoverable', async () => {
    await expect(
      processWriteQueueJob(
        { name: WRITE_QUEUE_JOB_NAME, data: { schemaVersion: 1, jobId } },
        {
          run: vi.fn(async () => ({ status: 'lease_lost' as const, runId: 'run-1' })),
        },
      ),
    ).rejects.toBeInstanceOf(RetryableQueueDeliveryError)
    await expect(
      processWriteQueueJob(
        { name: WRITE_QUEUE_JOB_NAME, data: { schemaVersion: 1, jobId } },
        {
          run: vi.fn(async () => ({
            status: 'not_claimed' as const,
            reason: 'busy' as const,
          })),
        },
      ),
    ).rejects.toBeInstanceOf(RetryableQueueDeliveryError)
    await expect(
      processWriteQueueJob(
        { name: WRITE_QUEUE_JOB_NAME, data: { schemaVersion: 1, jobId, topic: 'leak' } },
        {
          run: vi.fn(async () => ({
            status: 'not_claimed' as const,
            reason: 'not_found' as const,
          })),
        },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableQueueMessageError)
  })

  it('uses a colon-free deterministic BullMQ id', () => {
    expect(writeQueueJobId(jobId)).toBe(`write-${jobId}`)
    expect(writeQueueJobId(jobId)).not.toContain(':')
  })

  it('maps only protocol violations to BullMQ UnrecoverableError', async () => {
    const runner = {
      run: vi.fn(async () => ({
        status: 'not_claimed' as const,
        reason: 'not_found' as const,
      })),
    }
    await expect(
      processBullMqWriteJob(
        { name: WRITE_QUEUE_JOB_NAME, data: { schemaVersion: 2, jobId } as never },
        runner,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(
      processBullMqWriteJob(
        { name: WRITE_QUEUE_JOB_NAME, data: { schemaVersion: 1, jobId } },
        {
          run: vi.fn(async () => ({ status: 'lease_lost' as const, runId: 'run-1' })),
        },
      ),
    ).rejects.toBeInstanceOf(RetryableQueueDeliveryError)
  })

  it('keeps bounded retry and retention defaults', () => {
    expect(DEFAULT_WRITE_JOB_OPTIONS).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000, jitter: 0.2 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
      sizeLimit: 1_024,
    })
  })
})
