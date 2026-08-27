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
  UnrecoverableQueueMessageError,
  WRITE_QUEUE_JOB_NAME,
  processWriteQueueJob,
  type WriteJobPublisher,
  type WriteJobRunner,
  type WriteQueueJobData,
} from './outbox-dispatcher'
import type { WorkerRunResult } from './runner'

export const DEFAULT_WRITE_QUEUE_NAME = 'vibe-writer-write'

// 这里只负责队列消息的传输重试；消息被再次消费后是否可以执行业务，仍由
// PostgreSQL Job 状态、租约、幂等键和 Checkpoint 共同判断。
export const DEFAULT_WRITE_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.2 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800, count: 10_000 },
  sizeLimit: 1_024,
  stackTraceLimit: 10,
} satisfies DefaultJobOptions

export type BullMqWritePublisherOptions = {
  queueName?: string
  connection: ConnectionOptions
  prefix?: string
  defaultJobOptions?: DefaultJobOptions
}

export class BullMqWritePublisher implements WriteJobPublisher {
  private readonly queue: Queue<WriteQueueJobData, WorkerRunResult, string>

  constructor(options: BullMqWritePublisherOptions) {
    this.queue = new Queue(options.queueName ?? DEFAULT_WRITE_QUEUE_NAME, {
      connection: options.connection,
      ...(options.prefix ? { prefix: options.prefix } : {}),
      defaultJobOptions: {
        ...DEFAULT_WRITE_JOB_OPTIONS,
        ...options.defaultJobOptions,
      },
    } satisfies QueueOptions)
  }

  async enqueue(
    name: typeof WRITE_QUEUE_JOB_NAME,
    data: WriteQueueJobData,
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

export type BullMqWorkerObserver = {
  error(error: Error): void
  failed(jobId: string | undefined, error: Error): void
  stalled(jobId: string): void
}

export type BullMqWriteWorkerOptions = {
  queueName?: string
  connection: ConnectionOptions
  prefix?: string
  workerName: string
  concurrency: number
  lockDurationMs: number
  stalledIntervalMs?: number
  maxStalledCount?: number
  observer: BullMqWorkerObserver
}

export async function processBullMqWriteJob(
  job: Pick<Job<WriteQueueJobData>, 'name' | 'data'>,
  runner: WriteJobRunner,
): Promise<WorkerRunResult> {
  try {
    return await processWriteQueueJob(job, runner)
  } catch (error) {
    if (error instanceof UnrecoverableQueueMessageError) {
      throw new UnrecoverableError(error.message)
    }
    throw error
  }
}

export class BullMqWriteWorker {
  private readonly worker: Worker<WriteQueueJobData, WorkerRunResult, string>
  private runPromise: Promise<void> | null = null

  constructor(runner: WriteJobRunner, options: BullMqWriteWorkerOptions) {
    if (!options.workerName.trim()) throw new Error('workerName is required')
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error('concurrency must be a positive integer')
    }
    if (!Number.isInteger(options.lockDurationMs) || options.lockDurationMs <= 0) {
      throw new Error('lockDurationMs must be a positive integer')
    }

    this.worker = new Worker<WriteQueueJobData, WorkerRunResult, string>(
      options.queueName ?? DEFAULT_WRITE_QUEUE_NAME,
      (job) => processBullMqWriteJob(job, runner),
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
    if (this.runPromise) throw new Error('BullMQ worker has already started')
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
