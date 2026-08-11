import { abortableSleep } from './runner'

export type ProcessRuntimeComponents = {
  startHealth?: () => Promise<void>
  checkDatabase?: () => Promise<void>
  startPublisher?: () => Promise<void>
  startConsumer?: () => Promise<void>
  dispatchBatch?: () => Promise<unknown>
  closeConsumer?: () => Promise<void>
  closePublisher?: () => Promise<void>
  closeCheckpoint?: () => Promise<void>
  closeDatabase: () => Promise<void>
  markReady?: () => void
  markDraining?: () => void
  closeHealth?: () => Promise<void>
  onDispatcherError(error: unknown): void
}

export class WorkerProcessRuntime {
  private readonly stop = new AbortController()
  private loop: Promise<void> | null = null
  private started = false
  private closed = false

  constructor(
    private readonly components: ProcessRuntimeComponents,
    private readonly pollMs: number,
  ) {}

  async start() {
    if (this.started) throw new Error('Worker process already started')
    this.started = true
    await this.components.startHealth?.()
    await this.components.checkDatabase?.()
    await this.components.startPublisher?.()
    await this.components.startConsumer?.()
    this.components.markReady?.()
    if (this.components.dispatchBatch) this.loop = this.dispatchLoop()
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.components.markDraining?.()
    this.stop.abort('shutdown')
    await this.loop
    await this.components.closeConsumer?.()
    await this.components.closePublisher?.()
    await this.components.closeCheckpoint?.()
    await this.components.closeDatabase()
    await this.components.closeHealth?.()
  }

  private async dispatchLoop() {
    while (!this.stop.signal.aborted) {
      try {
        await this.components.dispatchBatch?.()
      } catch (error) {
        this.components.onDispatcherError(error)
      }
      try {
        await abortableSleep(this.pollMs, this.stop.signal)
      } catch {
        return
      }
    }
  }
}
