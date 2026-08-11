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
  MEMORY_EXTRACTION_QUEUE_JOB_NAME,
  MemoryExtractionTerminalError,
  processMemoryExtractionQueueJob,
  type MemoryExtractionPublisher,
  type MemoryExtractionQueueData,
  type MemoryExtractionRunResult,
  type MemoryExtractionService,
} from './memory-extraction'
import { UnrecoverableQueueMessageError } from './outbox-dispatcher'
import type { BullMqWorkerObserver } from './bullmq-adapter'

export const DEFAULT_MEMORY_QUEUE_NAME = 'vibe-writer-memory'

export const DEFAULT_MEMORY_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.2 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800, count: 10_000 },
  sizeLimit: 1_024,
  stackTraceLimit: 10,
} satisfies DefaultJobOptions

export type BullMqMemoryPublisherOptions = {
  queueName?: string
  connection: ConnectionOptions
  prefix?: string
  defaultJobOptions?: DefaultJobOptions
}

export class BullMqMemoryPublisher implements MemoryExtractionPublisher {
  private readonly queue: Queue<MemoryExtractionQueueData, MemoryExtractionRunResult, string>

  constructor(options: BullMqMemoryPublisherOptions) {
    this.queue = new Queue(options.queueName ?? DEFAULT_MEMORY_QUEUE_NAME, {
      connection: options.connection,
      ...(options.prefix ? { prefix: options.prefix } : {}),
      defaultJobOptions: { ...DEFAULT_MEMORY_JOB_OPTIONS, ...options.defaultJobOptions },
    } satisfies QueueOptions)
  }

  async enqueue(
    name: typeof MEMORY_EXTRACTION_QUEUE_JOB_NAME,
    data: MemoryExtractionQueueData,
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

export async function processBullMqMemoryExtractionJob(
  job: Pick<Job<MemoryExtractionQueueData>, 'name' | 'data'>,
  service: Pick<MemoryExtractionService, 'run'>,
): Promise<MemoryExtractionRunResult> {
  try {
    return await processMemoryExtractionQueueJob(job, service)
  } catch (error) {
    if (
      error instanceof UnrecoverableQueueMessageError ||
      error instanceof MemoryExtractionTerminalError
    ) {
      throw new UnrecoverableError(error.message)
    }
    throw error
  }
}

export type BullMqMemoryWorkerOptions = {
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

export class BullMqMemoryWorker {
  private readonly worker: Worker<MemoryExtractionQueueData, MemoryExtractionRunResult, string>
  private runPromise: Promise<void> | null = null

  constructor(
    service: Pick<MemoryExtractionService, 'run'>,
    options: BullMqMemoryWorkerOptions,
  ) {
    if (!options.workerName.trim()) throw new Error('workerName is required')
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error('concurrency must be a positive integer')
    }
    if (!Number.isInteger(options.lockDurationMs) || options.lockDurationMs <= 0) {
      throw new Error('lockDurationMs must be a positive integer')
    }
    this.worker = new Worker<MemoryExtractionQueueData, MemoryExtractionRunResult, string>(
      options.queueName ?? DEFAULT_MEMORY_QUEUE_NAME,
      (job) => processBullMqMemoryExtractionJob(job, service),
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
    if (this.runPromise) throw new Error('BullMQ Memory worker has already started')
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
