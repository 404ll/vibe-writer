export type LiveEvalSamplerControl = {
  scanActivePolicies(input: {
    policyLimit: number
    sourceBatchSize: number
  }): Promise<unknown>
}

export type LiveEvalSamplerOptions = {
  pollIntervalMs: number
  policyLimit: number
  sourceBatchSize: number
  onError(error: unknown): void
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export class LiveEvalSamplerLoop {
  private readonly stop = new AbortController()
  private loop: Promise<void> | null = null
  private closed = false

  constructor(
    private readonly control: LiveEvalSamplerControl,
    private readonly options: LiveEvalSamplerOptions,
  ) {
    positiveInteger(options.pollIntervalMs, 'pollIntervalMs')
    positiveInteger(options.policyLimit, 'policyLimit')
    positiveInteger(options.sourceBatchSize, 'sourceBatchSize')
  }

  async start() {
    if (this.loop) throw new Error('Live Eval sampler has already started')
    if (this.closed) throw new Error('Live Eval sampler is already closed')
    let firstTickFinished!: () => void
    const firstTick = new Promise<void>((resolve) => { firstTickFinished = resolve })
    this.loop = this.run(firstTickFinished)
    void this.loop.catch(() => undefined)
    await firstTick
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.stop.abort('shutdown')
    await this.loop
    this.loop = null
  }

  private async run(firstTickFinished: () => void) {
    let first = true
    while (!this.stop.signal.aborted) {
      try {
        await this.control.scanActivePolicies({
          policyLimit: this.options.policyLimit,
          sourceBatchSize: this.options.sourceBatchSize,
        })
      } catch (error) {
        this.options.onError(error)
      } finally {
        if (first) {
          first = false
          firstTickFinished()
        }
      }
      await sleep(this.options.pollIntervalMs, this.stop.signal)
    }
  }
}
