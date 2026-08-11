import { abortableSleep } from './runner'

export type MemorySourceSignalRetentionStore = {
  expireDue(limit: number): Promise<{ signalsDeleted: number }>
  inspectExpiryBacklog(alertThreshold: number): Promise<{
    signalsDue: number
    signalsCapped: boolean
  }>
}

export type MemoryRetentionStore = {
  expireDue(limit: number): Promise<{
    memoriesDeleted: number
    candidatesDeleted: number
  }>
  inspectExpiryBacklog(alertThreshold: number): Promise<{
    memoriesDue: number
    memoriesCapped: boolean
    candidatesDue: number
    candidatesCapped: boolean
  }>
}

export type MemoryRetentionBatchReport = {
  schemaVersion: 1
  workerId: string
  status: 'idle' | 'progress' | 'backlog_alert'
  startedAt: string
  finishedAt: string
  durationMs: number
  batchSize: number
  deleted: {
    sourceSignals: number
    memories: number
    candidates: number
  }
  remaining: {
    sourceSignalsDue: number
    memoriesDue: number
    candidatesDue: number
    sampledTotalDue: number
    sampleCapped: boolean
    alertThreshold: number
  }
}

export type MemoryRetentionMaintenanceOptions = {
  workerId: string
  batchSize: number
  backlogAlertThreshold: number
  clock?: () => Date
}

function positiveBoundedInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  }
  return value
}

function instant(value: Date, name: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`)
  return value
}

export class MemoryRetentionMaintenanceService {
  private readonly clock: () => Date

  constructor(
    private readonly sourceSignals: MemorySourceSignalRetentionStore,
    private readonly memories: MemoryRetentionStore,
    private readonly options: MemoryRetentionMaintenanceOptions,
  ) {
    if (!options.workerId.trim() || options.workerId.length > 256) {
      throw new Error('Memory retention workerId must contain 1-256 characters')
    }
    positiveBoundedInteger(options.batchSize, 'Memory retention batchSize', 1_000)
    positiveBoundedInteger(
      options.backlogAlertThreshold,
      'Memory retention backlogAlertThreshold',
      10_000,
    )
    this.clock = options.clock ?? (() => new Date())
  }

  async runBatch(): Promise<MemoryRetentionBatchReport> {
    const startedAt = instant(this.clock(), 'Memory retention batch start')
    // Source erasure must run first because it settles extraction state and
    // cascades source-owned candidates/revisions before generic expiry scans.
    const sourceResult = await this.sourceSignals.expireDue(this.options.batchSize)
    const memoryResult = await this.memories.expireDue(this.options.batchSize)
    const [sourceBacklog, memoryBacklog] = await Promise.all([
      this.sourceSignals.inspectExpiryBacklog(this.options.backlogAlertThreshold),
      this.memories.inspectExpiryBacklog(this.options.backlogAlertThreshold),
    ])
    const finishedAt = instant(this.clock(), 'Memory retention batch finish')
    const sampledTotalDue = sourceBacklog.signalsDue + memoryBacklog.memoriesDue +
      memoryBacklog.candidatesDue
    const sampleCapped = sourceBacklog.signalsCapped || memoryBacklog.memoriesCapped ||
      memoryBacklog.candidatesCapped
    const deletedTotal = sourceResult.signalsDeleted + memoryResult.memoriesDeleted +
      memoryResult.candidatesDeleted
    const backlogAlert = sampleCapped || sampledTotalDue >= this.options.backlogAlertThreshold
    return {
      schemaVersion: 1,
      workerId: this.options.workerId,
      status: backlogAlert ? 'backlog_alert' : deletedTotal > 0 ? 'progress' : 'idle',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      batchSize: this.options.batchSize,
      deleted: {
        sourceSignals: sourceResult.signalsDeleted,
        memories: memoryResult.memoriesDeleted,
        candidates: memoryResult.candidatesDeleted,
      },
      remaining: {
        sourceSignalsDue: sourceBacklog.signalsDue,
        memoriesDue: memoryBacklog.memoriesDue,
        candidatesDue: memoryBacklog.candidatesDue,
        sampledTotalDue,
        sampleCapped,
        alertThreshold: this.options.backlogAlertThreshold,
      },
    }
  }
}

export type MemoryRetentionProcessComponents = {
  startHealth?: () => Promise<void>
  checkDatabase: () => Promise<void>
  runBatch: () => Promise<MemoryRetentionBatchReport>
  closeDatabase: () => Promise<void>
  markReady?: () => void
  markDraining?: () => void
  closeHealth?: () => Promise<void>
  onBatch(report: MemoryRetentionBatchReport): void
  onError(error: unknown): void
}

export type MemoryRetentionProcessOptions = {
  pollMs: number
  backlogPollMs: number
}

export class MemoryRetentionProcessRuntime {
  private readonly stop = new AbortController()
  private loop: Promise<void> | null = null
  private started = false
  private closed = false

  constructor(
    private readonly components: MemoryRetentionProcessComponents,
    private readonly options: MemoryRetentionProcessOptions,
  ) {
    positiveBoundedInteger(options.pollMs, 'Memory retention pollMs', 86_400_000)
    positiveBoundedInteger(options.backlogPollMs, 'Memory retention backlogPollMs', 60_000)
    if (options.backlogPollMs > options.pollMs) {
      throw new Error('Memory retention backlogPollMs cannot exceed pollMs')
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Memory retention process already started')
    this.started = true
    await this.components.startHealth?.()
    await this.components.checkDatabase()
    this.components.markReady?.()
    this.loop = this.maintenanceLoop()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.components.markDraining?.()
    this.stop.abort('shutdown')
    await this.loop
    await this.components.closeDatabase()
    await this.components.closeHealth?.()
  }

  private async maintenanceLoop(): Promise<void> {
    while (!this.stop.signal.aborted) {
      let delayMs = this.options.pollMs
      try {
        const report = await this.components.runBatch()
        try {
          this.components.onBatch(report)
        } catch {
          // Observability must not stop retention enforcement.
        }
        if (report.remaining.sampledTotalDue > 0) delayMs = this.options.backlogPollMs
      } catch (error) {
        try {
          this.components.onError(error)
        } catch {
          // Error reporting is best effort; the next bounded poll still runs.
        }
      }
      try {
        await abortableSleep(delayMs, this.stop.signal)
      } catch {
        return
      }
    }
  }
}
