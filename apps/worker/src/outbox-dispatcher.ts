import type {
  ClaimOutboxBatchInput,
  ClaimedOutboxEvent,
  OutboxLockIdentity,
  ReleaseOutboxFailureInput,
} from '@vibe-writer/db'
import type { WorkerRunResult } from './runner'

export const WRITE_QUEUE_JOB_NAME = 'write.article'
export const WRITE_JOB_SCHEMA_VERSION = 1 as const

export type WriteQueueJobData = {
  schemaVersion: typeof WRITE_JOB_SCHEMA_VERSION
  jobId: string
}

export type OutboxDispatchControl = {
  claimBatch(input: ClaimOutboxBatchInput): Promise<ClaimedOutboxEvent[]>
  markPublished(identity: OutboxLockIdentity): Promise<'published' | 'lease_lost'>
  releaseFailure(input: ReleaseOutboxFailureInput): Promise<'released' | 'lease_lost'>
}

export type WriteJobPublisher = {
  enqueue(
    name: typeof WRITE_QUEUE_JOB_NAME,
    data: WriteQueueJobData,
    options: { jobId: string },
  ): Promise<void>
}

export type OutboxDispatcherOptions = {
  dispatcherId: string
  batchSize: number
  lockTimeoutMs: number
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  now?: () => Date
}

export type OutboxDispatchResult =
  | { eventId: string; status: 'published'; queueJobId: string }
  | { eventId: string; status: 'retry_scheduled' | 'failed' | 'lease_lost' }

export type WriteJobRunner = {
  run(jobId: string): Promise<WorkerRunResult>
}

export class UnrecoverableQueueMessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnrecoverableQueueMessageError'
  }
}

export class RetryableQueueDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryableQueueDeliveryError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function writeQueueJobId(jobId: string): string {
  if (!UUID_PATTERN.test(jobId)) throw new Error('Outbox jobId must be a UUID')
  return `write-${jobId.toLowerCase()}`
}

function parseWriteQueueData(value: unknown): WriteQueueJobData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnrecoverableQueueMessageError('Write job payload must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 2 ||
    keys[0] !== 'jobId' ||
    keys[1] !== 'schemaVersion' ||
    record.schemaVersion !== WRITE_JOB_SCHEMA_VERSION ||
    typeof record.jobId !== 'string'
  ) {
    throw new UnrecoverableQueueMessageError('Unsupported write job payload schema')
  }
  try {
    writeQueueJobId(record.jobId)
  } catch {
    throw new UnrecoverableQueueMessageError('Write job jobId must be a UUID')
  }
  return { schemaVersion: WRITE_JOB_SCHEMA_VERSION, jobId: record.jobId }
}

export async function processWriteQueueJob(
  job: { name: string; data: unknown },
  runner: WriteJobRunner,
): Promise<WorkerRunResult> {
  if (job.name !== WRITE_QUEUE_JOB_NAME) {
    throw new UnrecoverableQueueMessageError(`Unsupported queue job ${job.name}`)
  }
  const data = parseWriteQueueData(job.data)
  const result = await runner.run(data.jobId)
  if (
    result.status === 'lease_lost' ||
    (result.status === 'not_claimed' && result.reason === 'busy')
  ) {
    throw new RetryableQueueDeliveryError(
      result.status === 'lease_lost'
        ? `Database lease lost for ${data.jobId}`
        : `Database job ${data.jobId} is still owned by another lease`,
    )
  }
  return result
}

function queueData(event: ClaimedOutboxEvent): WriteQueueJobData {
  if (
    event.aggregateType !== 'job' ||
    !['job.enqueue.requested', 'job.resume.requested'].includes(event.eventType)
  ) {
    throw new Error(`Unsupported outbox event ${event.aggregateType}/${event.eventType}`)
  }
  const keys = Object.keys(event.payload).sort()
  if (
    keys.length !== 1 ||
    keys[0] !== 'jobId' ||
    typeof event.payload.jobId !== 'string' ||
    event.payload.jobId !== event.aggregateId
  ) {
    throw new Error('Outbox payload must contain only the matching jobId')
  }
  writeQueueJobId(event.payload.jobId)
  return { schemaVersion: WRITE_JOB_SCHEMA_VERSION, jobId: event.payload.jobId }
}

export function outboxQueueJobId(event: ClaimedOutboxEvent): string {
  const data = queueData(event)
  return event.eventType === 'job.resume.requested'
    ? `resume-${event.id.toLowerCase()}`
    : writeQueueJobId(data.jobId)
}

function requirePositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive`)
}

export class OutboxDispatcher {
  private readonly now: () => Date

  constructor(
    private readonly control: OutboxDispatchControl,
    private readonly publisher: WriteJobPublisher,
    private readonly options: OutboxDispatcherOptions,
  ) {
    if (!options.dispatcherId.trim()) throw new Error('dispatcherId is required')
    for (const name of [
      'batchSize',
      'lockTimeoutMs',
      'maxAttempts',
      'initialBackoffMs',
      'maxBackoffMs',
    ] as const) {
      requirePositiveInteger(options[name], name)
    }
    if (options.initialBackoffMs > options.maxBackoffMs) {
      throw new Error('initialBackoffMs cannot exceed maxBackoffMs')
    }
    this.now = options.now ?? (() => new Date())
  }

  async dispatchBatch(): Promise<OutboxDispatchResult[]> {
    const events = await this.control.claimBatch({
      dispatcherId: this.options.dispatcherId,
      aggregateType: 'job',
      limit: this.options.batchSize,
      lockTimeoutMs: this.options.lockTimeoutMs,
    })
    return Promise.all(events.map((event) => this.dispatch(event)))
  }

  private async dispatch(event: ClaimedOutboxEvent): Promise<OutboxDispatchResult> {
    const identity = { eventId: event.id, lockToken: event.lockToken }
    try {
      const data = queueData(event)
      const queueJobId = outboxQueueJobId(event)
      await this.publisher.enqueue(WRITE_QUEUE_JOB_NAME, data, { jobId: queueJobId })
      const marked = await this.control.markPublished(identity)
      return marked === 'published'
        ? { eventId: event.id, status: 'published', queueJobId }
        : { eventId: event.id, status: 'lease_lost' }
    } catch (error) {
      const terminal =
        event.attempts >= this.options.maxAttempts ||
        (error instanceof Error &&
          (error.message.startsWith('Unsupported outbox event') ||
            error.message.startsWith('Outbox payload') ||
            error.message.startsWith('Outbox jobId')))
      const delay = Math.min(
        this.options.maxBackoffMs,
        this.options.initialBackoffMs * 2 ** Math.max(0, event.attempts - 1),
      )
      const released = await this.control.releaseFailure({
        ...identity,
        error: error instanceof Error ? error.message : 'Outbox publish failed.',
        retryAt: new Date(this.now().getTime() + delay),
        terminal,
      })
      if (released === 'lease_lost') return { eventId: event.id, status: 'lease_lost' }
      return { eventId: event.id, status: terminal ? 'failed' : 'retry_scheduled' }
    }
  }
}
