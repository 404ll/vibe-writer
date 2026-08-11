import {
  Queue,
  UnrecoverableError,
  Worker,
  type ConnectionOptions,
  type DefaultJobOptions,
  type Job,
  type QueueOptions,
  type WorkerOptions,
} from 'bullmq'
import {
  DEFAULT_EVAL_QUEUE_NAME,
  EVAL_QUEUE_JOB_NAME,
  UnrecoverableEvalQueueMessageError,
  processEvalQueueJob,
  type EvalQueueJobData,
  type EvalQueuePublisher,
  type EvalQueueRunner,
  type EvalQueueRunResult,
} from './queue-protocol.ts'

export const DEFAULT_EVAL_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.2 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800, count: 10_000 },
  sizeLimit: 1_024,
  stackTraceLimit: 10,
} satisfies DefaultJobOptions

export type BullMqEvalPublisherOptions = {
  queueName?: string
  connection: ConnectionOptions
  prefix?: string
  defaultJobOptions?: DefaultJobOptions
}

export class BullMqEvalPublisher implements EvalQueuePublisher {
  private readonly queue: Queue<EvalQueueJobData, EvalQueueRunResult, string>

  constructor(options: BullMqEvalPublisherOptions) {
    this.queue = new Queue(options.queueName ?? DEFAULT_EVAL_QUEUE_NAME, {
      connection: options.connection,
      ...(options.prefix ? { prefix: options.prefix } : {}),
      defaultJobOptions: {
        ...DEFAULT_EVAL_JOB_OPTIONS,
        ...options.defaultJobOptions,
      },
    } satisfies QueueOptions)
  }

  async enqueue(
    name: typeof EVAL_QUEUE_JOB_NAME,
    data: EvalQueueJobData,
    options: { jobId: string },
  ): Promise<void> {
    await this.queue.add(name, data, options)
  }

  async waitUntilReady() {
    return this.queue.waitUntilReady()
  }

  async close() {
    await this.queue.close()
  }
}

export type BullMqEvalWorkerObserver = {
  error(error: Error): void
  failed(jobId: string | undefined, error: Error): void
  stalled(jobId: string): void
}

export type BullMqEvalWorkerOptions = {
  queueName?: string
  connection: ConnectionOptions
  prefix?: string
  workerName: string
  concurrency: number
  lockDurationMs: number
  stalledIntervalMs?: number
  maxStalledCount?: number
  observer: BullMqEvalWorkerObserver
}

export async function processBullMqEvalJob(
  job: Pick<Job<EvalQueueJobData>, 'name' | 'data'>,
  runner: EvalQueueRunner,
): Promise<EvalQueueRunResult> {
  try {
    return await processEvalQueueJob(job, runner)
  } catch (error) {
    if (error instanceof UnrecoverableEvalQueueMessageError) {
      throw new UnrecoverableError(error.message)
    }
    throw error
  }
}

export class BullMqEvalWorker {
  private readonly worker: Worker<EvalQueueJobData, EvalQueueRunResult, string>
  private runPromise: Promise<void> | null = null

  constructor(runner: EvalQueueRunner, options: BullMqEvalWorkerOptions) {
    if (!options.workerName.trim()) throw new Error('workerName is required')
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error('concurrency must be a positive integer')
    }
    if (!Number.isInteger(options.lockDurationMs) || options.lockDurationMs <= 0) {
      throw new Error('lockDurationMs must be a positive integer')
    }

    this.worker = new Worker<EvalQueueJobData, EvalQueueRunResult, string>(
      options.queueName ?? DEFAULT_EVAL_QUEUE_NAME,
      (job) => processBullMqEvalJob(job, runner),
      {
        connection: options.connection,
        ...(options.prefix ? { prefix: options.prefix } : {}),
        name: options.workerName,
        concurrency: options.concurrency,
        lockDuration: options.lockDurationMs,
        stalledInterval: options.stalledIntervalMs ?? 30_000,
        maxStalledCount: options.maxStalledCount ?? 1,
        autorun: false,
      } satisfies WorkerOptions,
    )

    this.worker.on('error', (error) => options.observer.error(error))
    this.worker.on('failed', (job, error) => options.observer.failed(job?.id, error))
    this.worker.on('stalled', (jobId) => options.observer.stalled(jobId))
  }

  async start(): Promise<void> {
    if (this.runPromise) throw new Error('BullMQ Eval worker has already started')
    this.runPromise = this.worker.run()
    void this.runPromise.catch(() => undefined)
    await this.worker.waitUntilReady()
  }

  async close(force = false): Promise<void> {
    await this.worker.close(force)
    await this.runPromise
    this.runPromise = null
  }
}
