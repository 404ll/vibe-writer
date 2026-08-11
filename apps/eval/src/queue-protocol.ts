import type {
  ClaimOutboxBatchInput,
  ClaimedOutboxEvent,
  OutboxLockIdentity,
  ReleaseOutboxFailureInput,
} from '@vibe-writer/db'

export const EVAL_QUEUE_JOB_NAME = 'eval.run'
export const EVAL_QUEUE_SCHEMA_VERSION = 1 as const
export const DEFAULT_EVAL_QUEUE_NAME = 'vibe-writer-eval'

export type EvalQueueJobData = {
  schemaVersion: typeof EVAL_QUEUE_SCHEMA_VERSION
  evalRunId: string
}

export type EvalQueueRunResult =
  | { status: 'completed' | 'failed'; evalRunId: string }
  | { status: 'lease_lost'; evalRunId: string }
  | { status: 'not_claimed'; reason: 'busy' | 'terminal' | 'not_found' }

export type EvalQueueRunner = {
  run(evalRunId: string): Promise<EvalQueueRunResult>
}

export type EvalQueuePublisher = {
  enqueue(
    name: typeof EVAL_QUEUE_JOB_NAME,
    data: EvalQueueJobData,
    options: { jobId: string },
  ): Promise<void>
}

export type EvalOutboxControl = {
  claimBatch(input: ClaimOutboxBatchInput): Promise<ClaimedOutboxEvent[]>
  markPublished(identity: OutboxLockIdentity): Promise<'published' | 'lease_lost'>
  releaseFailure(input: ReleaseOutboxFailureInput): Promise<'released' | 'lease_lost'>
}

export type EvalOutboxDispatcherOptions = {
  dispatcherId: string
  batchSize: number
  lockTimeoutMs: number
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  now?: () => Date
}

export type EvalOutboxDispatchResult =
  | { eventId: string; status: 'published'; queueJobId: string }
  | { eventId: string; status: 'retry_scheduled' | 'failed' | 'lease_lost' }

export class UnrecoverableEvalQueueMessageError extends Error {
  readonly name = 'UnrecoverableEvalQueueMessageError'
}

export class RetryableEvalQueueDeliveryError extends Error {
  readonly name = 'RetryableEvalQueueDeliveryError'
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function evalQueueJobId(evalRunId: string): string {
  if (!UUID_PATTERN.test(evalRunId)) throw new Error('Eval run id must be a UUID')
  return `eval-${evalRunId.toLowerCase()}`
}

function parseEvalQueueData(value: unknown): EvalQueueJobData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnrecoverableEvalQueueMessageError('Eval job payload must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 2 || keys[0] !== 'evalRunId' || keys[1] !== 'schemaVersion' ||
    record.schemaVersion !== EVAL_QUEUE_SCHEMA_VERSION || typeof record.evalRunId !== 'string'
  ) {
    throw new UnrecoverableEvalQueueMessageError('Unsupported Eval job payload schema')
  }
  try {
    evalQueueJobId(record.evalRunId)
  } catch {
    throw new UnrecoverableEvalQueueMessageError('Eval job evalRunId must be a UUID')
  }
  return { schemaVersion: EVAL_QUEUE_SCHEMA_VERSION, evalRunId: record.evalRunId }
}

export async function processEvalQueueJob(
  job: { name: string; data: unknown },
  runner: EvalQueueRunner,
): Promise<EvalQueueRunResult> {
  if (job.name !== EVAL_QUEUE_JOB_NAME) {
    throw new UnrecoverableEvalQueueMessageError(`Unsupported Eval queue job ${job.name}`)
  }
  const data = parseEvalQueueData(job.data)
  const result = await runner.run(data.evalRunId)
  if (
    result.status === 'lease_lost' ||
    (result.status === 'not_claimed' && result.reason === 'busy')
  ) {
    throw new RetryableEvalQueueDeliveryError(
      result.status === 'lease_lost'
        ? `Eval lease lost for ${data.evalRunId}`
        : `Eval run ${data.evalRunId} is still owned by another lease`,
    )
  }
  return result
}

function queueData(event: ClaimedOutboxEvent): EvalQueueJobData {
  if (event.aggregateType !== 'eval_run' || event.eventType !== 'eval.run.requested') {
    throw new Error(`Unsupported Eval outbox event ${event.aggregateType}/${event.eventType}`)
  }
  const keys = Object.keys(event.payload).sort()
  if (
    keys.length !== 1 || keys[0] !== 'evalRunId' ||
    typeof event.payload.evalRunId !== 'string' || event.payload.evalRunId !== event.aggregateId
  ) {
    throw new Error('Eval outbox payload must contain only the matching evalRunId')
  }
  evalQueueJobId(event.payload.evalRunId)
  return { schemaVersion: EVAL_QUEUE_SCHEMA_VERSION, evalRunId: event.payload.evalRunId }
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive`)
}

export class EvalOutboxDispatcher {
  private readonly now: () => Date

  constructor(
    private readonly control: EvalOutboxControl,
    private readonly publisher: EvalQueuePublisher,
    private readonly options: EvalOutboxDispatcherOptions,
  ) {
    if (!options.dispatcherId.trim()) throw new Error('dispatcherId is required')
    for (const name of [
      'batchSize', 'lockTimeoutMs', 'maxAttempts', 'initialBackoffMs', 'maxBackoffMs',
    ] as const) positiveInteger(options[name], name)
    if (options.initialBackoffMs > options.maxBackoffMs) {
      throw new Error('initialBackoffMs cannot exceed maxBackoffMs')
    }
    this.now = options.now ?? (() => new Date())
  }

  async dispatchBatch(): Promise<EvalOutboxDispatchResult[]> {
    const events = await this.control.claimBatch({
      dispatcherId: this.options.dispatcherId,
      aggregateType: 'eval_run',
      limit: this.options.batchSize,
      lockTimeoutMs: this.options.lockTimeoutMs,
    })
    return Promise.all(events.map((event) => this.dispatch(event)))
  }

  private async dispatch(event: ClaimedOutboxEvent): Promise<EvalOutboxDispatchResult> {
    const identity = { eventId: event.id, lockToken: event.lockToken }
    try {
      const data = queueData(event)
      const queueJobId = evalQueueJobId(data.evalRunId)
      await this.publisher.enqueue(EVAL_QUEUE_JOB_NAME, data, { jobId: queueJobId })
      const marked = await this.control.markPublished(identity)
      return marked === 'published'
        ? { eventId: event.id, status: 'published', queueJobId }
        : { eventId: event.id, status: 'lease_lost' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Eval outbox publish failed.'
      const terminal = event.attempts >= this.options.maxAttempts ||
        message.startsWith('Unsupported Eval outbox event') ||
        message.startsWith('Eval outbox payload') ||
        message.startsWith('Eval run id')
      const delay = Math.min(
        this.options.maxBackoffMs,
        this.options.initialBackoffMs * 2 ** Math.max(0, event.attempts - 1),
      )
      const released = await this.control.releaseFailure({
        ...identity,
        error: message,
        retryAt: new Date(this.now().getTime() + delay),
        terminal,
      })
      if (released === 'lease_lost') return { eventId: event.id, status: 'lease_lost' }
      return { eventId: event.id, status: terminal ? 'failed' : 'retry_scheduled' }
    }
  }
}
