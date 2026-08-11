import type {
  ClaimJobInput,
  CompleteClaimInput,
  CompleteClaimResult,
  JobIntervention,
  LeaseHeartbeatResult,
  LeaseIdentity,
  JobStatus,
  PauseClaimInput,
  PauseClaimResult,
  RunExecutionSnapshot,
  TerminateClaimInput,
  TerminateClaimResult,
} from '@vibe-writer/db'

export type ClaimedJob = {
  job: {
    id: string
    topic: string
    style: string
    targetWords: number | null
    intervention: JobIntervention
  }
  run: {
    id: string
    modelProfile: RunExecutionSnapshot['modelProfile']
    promptVersion: string
    graphVersion: string
    toolVersions: RunExecutionSnapshot['toolVersions']
    codeRevision: string
  }
  leaseToken: string
}

export type WorkerLeaseControl = {
  claimJob(input: ClaimJobInput): Promise<ClaimedJob | null>
  getJob(jobId: string): Promise<{ status: JobStatus } | null>
  heartbeatClaim(
    identity: LeaseIdentity,
    leaseDurationMs: number,
  ): Promise<LeaseHeartbeatResult>
  completeClaim(input: CompleteClaimInput): Promise<CompleteClaimResult>
  terminateClaim(input: TerminateClaimInput): Promise<TerminateClaimResult>
  pauseClaim(input: PauseClaimInput): Promise<PauseClaimResult>
}

export type WorkerExecutionContext = LeaseIdentity & {
  job: ClaimedJob['job']
  run: ClaimedJob['run']
  signal: AbortSignal
}

export type WorkerExecutionResult =
  | {
      status: 'completed'
      exportIntent: { idempotencyKey: string; markdown: string }
    }
  | { status: 'awaiting_input'; interruptId: string; outline: string[] }
  | { status: 'failed'; errorCode: string; errorMessage: string }

export type WorkerExecutor = {
  execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult>
}

export type WorkerJobRunnerOptions = {
  workerId: string
  leaseDurationMs: number
  heartbeatIntervalMs: number
  execution: RunExecutionSnapshot
  requestMemoryExtraction?: boolean
}

export type WorkerRunResult =
  | {
      status: 'not_claimed'
      reason: 'busy' | 'terminal' | 'awaiting_input' | 'not_found'
    }
  | { status: 'completed'; runId: string }
  | { status: 'awaiting_input'; runId: string }
  | { status: 'failed'; runId: string; errorCode: string }
  | { status: 'cancelled'; runId: string }
  | { status: 'lease_lost'; runId: string }

function abortError(): Error {
  return new DOMException('Operation aborted.', 'AbortError')
}

export function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return {
      code: error.name === 'AbortError' ? 'execution_aborted' : 'execution_failed',
      message:
        error.name === 'AbortError'
          ? 'Worker execution was aborted.'
          : 'Worker execution failed.',
    }
  }
  return { code: 'execution_failed', message: 'Worker execution failed.' }
}

export class WorkerJobRunner {
  constructor(
    private readonly control: WorkerLeaseControl,
    private readonly executor: WorkerExecutor,
    private readonly options: WorkerJobRunnerOptions,
    private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void> =
      abortableSleep,
  ) {
    if (!options.workerId.trim()) throw new Error('workerId is required')
    if (!Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive integer')
    }
    if (
      !Number.isInteger(options.heartbeatIntervalMs) ||
      options.heartbeatIntervalMs <= 0 ||
      options.heartbeatIntervalMs >= options.leaseDurationMs
    ) {
      throw new Error('heartbeatIntervalMs must be positive and shorter than the lease')
    }
  }

  async run(jobId: string): Promise<WorkerRunResult> {
    const claim = await this.control.claimJob({
      jobId,
      workerId: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
      execution: this.options.execution,
    })
    if (!claim) {
      const current = await this.control.getJob(jobId)
      if (!current) return { status: 'not_claimed', reason: 'not_found' }
      if (current.status === 'running' || current.status === 'queued') {
        return { status: 'not_claimed', reason: 'busy' }
      }
      if (current.status === 'awaiting_input') {
        return { status: 'not_claimed', reason: 'awaiting_input' }
      }
      return { status: 'not_claimed', reason: 'terminal' }
    }

    const identity: LeaseIdentity = {
      jobId,
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
    }
    const executionAbort = new AbortController()
    const heartbeatStop = new AbortController()
    const monitor = { outcome: null as Exclude<LeaseHeartbeatResult, 'renewed'> | null }
    const heartbeatTask = this.monitorHeartbeat(
      identity,
      executionAbort,
      heartbeatStop.signal,
      monitor,
    )

    let executionError: unknown = null
    let executionResult: WorkerExecutionResult | null = null
    try {
      executionResult = await this.executor.execute({
        ...identity,
        job: claim.job,
        run: claim.run,
        signal: executionAbort.signal,
      })
    } catch (error) {
      executionError = error
    } finally {
      heartbeatStop.abort()
      await heartbeatTask
    }

    if (monitor.outcome === 'lease_lost') {
      return { status: 'lease_lost', runId: identity.runId }
    }
    if (monitor.outcome === 'cancel_requested') {
      return this.settleCancellation(identity)
    }
    if (executionError) {
      const details = errorDetails(executionError)
      return this.settleFailure(identity, details.code, details.message)
    }
    if (!executionResult) {
      return this.settleFailure(
        identity,
        'invalid_execution_result',
        'Worker execution returned no result.',
      )
    }
    if (executionResult.status === 'failed') {
      return this.settleFailure(
        identity,
        executionResult.errorCode,
        executionResult.errorMessage,
      )
    }
    if (executionResult.status === 'awaiting_input') {
      const paused = await this.control.pauseClaim({
        ...identity,
        interruptId: executionResult.interruptId,
        outline: executionResult.outline,
      })
      if (paused.status === 'cancel_requested') return this.settleCancellation(identity)
      return paused.status === 'paused' || paused.status === 'replayed'
        ? { status: 'awaiting_input', runId: identity.runId }
        : { status: 'lease_lost', runId: identity.runId }
    }

    const completed = await this.control.completeClaim({
      ...identity,
      exportIdempotencyKey: executionResult.exportIntent.idempotencyKey,
      topic: claim.job.topic,
      markdown: executionResult.exportIntent.markdown,
      outputPath: null,
      requestMemoryExtraction: this.options.requestMemoryExtraction === true,
    })
    if (completed.status === 'cancel_requested') return this.settleCancellation(identity)
    return completed.status === 'committed' || completed.status === 'replayed'
      ? { status: 'completed', runId: identity.runId }
      : { status: 'lease_lost', runId: identity.runId }
  }

  private async settleCancellation(identity: LeaseIdentity): Promise<WorkerRunResult> {
    const settled = await this.control.terminateClaim({ ...identity, outcome: 'cancelled' })
    return settled.status === 'settled' || settled.status === 'replayed'
      ? { status: 'cancelled', runId: identity.runId }
      : { status: 'lease_lost', runId: identity.runId }
  }

  private async settleFailure(
    identity: LeaseIdentity,
    errorCode: string,
    errorMessage: string,
  ): Promise<WorkerRunResult> {
    const settled = await this.control.terminateClaim({
      ...identity,
      outcome: 'failed',
      errorCode,
      errorMessage,
    })
    if (settled.status === 'cancel_requested') return this.settleCancellation(identity)
    return settled.status === 'settled' || settled.status === 'replayed'
      ? { status: 'failed', runId: identity.runId, errorCode }
      : { status: 'lease_lost', runId: identity.runId }
  }

  private async monitorHeartbeat(
    identity: LeaseIdentity,
    executionAbort: AbortController,
    stopSignal: AbortSignal,
    monitor: { outcome: Exclude<LeaseHeartbeatResult, 'renewed'> | null },
  ) {
    while (!stopSignal.aborted) {
      try {
        await this.sleep(this.options.heartbeatIntervalMs, stopSignal)
      } catch {
        if (stopSignal.aborted) return
        monitor.outcome = 'lease_lost'
        executionAbort.abort('heartbeat_failed')
        return
      }
      if (stopSignal.aborted) return

      let heartbeat: LeaseHeartbeatResult
      try {
        heartbeat = await this.control.heartbeatClaim(identity, this.options.leaseDurationMs)
      } catch {
        monitor.outcome = 'lease_lost'
        executionAbort.abort('heartbeat_failed')
        return
      }
      if (heartbeat === 'renewed') continue
      monitor.outcome = heartbeat
      executionAbort.abort(heartbeat)
      return
    }
  }
}
