import type {
  ClaimEvalRunInput,
  CommitEvalRunReportInput,
  EvalRunLeaseIdentity,
  EvalRunRow,
  EvalSuiteRow,
} from '@vibe-writer/db'
import type { EvalCase, EvalJsonValue, EvalRunReport } from '@vibe-writer/eval-core'
import type { EvalQueueRunResult } from './queue-protocol'

export type ClaimedEvalContext = {
  run: EvalRunRow
  suite: EvalSuiteRow
  cases: Array<EvalCase<EvalJsonValue, EvalJsonValue>>
}

export type EvalQueueControl = {
  claimRun(input: ClaimEvalRunInput): Promise<
    | { status: 'claimed'; run: EvalRunRow }
    | { status: 'busy' | 'terminal' | 'not_found' }
  >
  heartbeatRun(
    identity: EvalRunLeaseIdentity,
    leaseDurationMs: number,
  ): Promise<'renewed' | 'lease_lost'>
  getClaimContext(identity: EvalRunLeaseIdentity): Promise<ClaimedEvalContext | null>
  commitClaimedReport<TOutput>(input: CommitEvalRunReportInput<TOutput>): Promise<
    | { status: 'committed'; run: EvalRunRow }
    | { status: 'lease_lost' }
  >
  failClaim(
    identity: EvalRunLeaseIdentity,
    errorCode: string,
    errorMessage: string,
  ): Promise<
    | { status: 'failed'; run: EvalRunRow }
    | { status: 'lease_lost' }
  >
}

export type EvalQueueExecutor = {
  execute(
    context: ClaimedEvalContext,
    signal: AbortSignal,
  ): Promise<EvalRunReport<unknown>>
}

export type EvalQueueRunnerOptions = {
  workerId: string
  leaseDurationMs: number
  heartbeatIntervalMs: number
}

function abortError(): Error {
  return new DOMException('Evaluation aborted.', 'AbortError')
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
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

export class DurableEvalQueueRunner {
  constructor(
    private readonly control: EvalQueueControl,
    private readonly executor: EvalQueueExecutor,
    private readonly options: EvalQueueRunnerOptions,
  ) {
    if (!options.workerId.trim()) throw new Error('workerId is required')
    if (!Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be positive')
    }
    if (
      !Number.isInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs <= 0 ||
      options.heartbeatIntervalMs >= options.leaseDurationMs
    ) {
      throw new Error('heartbeatIntervalMs must be positive and shorter than the lease')
    }
  }

  async run(evalRunId: string): Promise<EvalQueueRunResult> {
    const claim = await this.control.claimRun({
      evalRunId,
      workerId: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
    })
    if (claim.status !== 'claimed') {
      return { status: 'not_claimed', reason: claim.status }
    }
    if (!claim.run.leaseToken) throw new Error('Claimed Eval run is missing its lease token')
    const identity = { evalRunId, leaseToken: claim.run.leaseToken }
    const executionAbort = new AbortController()
    const heartbeatStop = new AbortController()
    const monitor = { leaseLost: false }
    const heartbeat = this.monitorHeartbeat(
      identity,
      executionAbort,
      heartbeatStop.signal,
      monitor,
    )
    let report: EvalRunReport<unknown> | null = null
    let executionError: unknown = null
    try {
      const context = await this.control.getClaimContext(identity)
      if (!context) {
        monitor.leaseLost = true
        executionAbort.abort()
      } else {
        report = await this.executor.execute(context, executionAbort.signal)
      }
    } catch (error) {
      executionError = error
    } finally {
      heartbeatStop.abort()
      await heartbeat
    }
    if (monitor.leaseLost) return { status: 'lease_lost', evalRunId }
    if (executionError || !report) {
      const failed = await this.control.failClaim(
        identity,
        'eval_executor_failed',
        executionError instanceof Error ? executionError.message : 'Eval executor failed.',
      )
      return failed.status === 'failed'
        ? { status: 'failed', evalRunId }
        : { status: 'lease_lost', evalRunId }
    }
    const committed = await this.control.commitClaimedReport({ ...identity, report })
    return committed.status === 'committed'
      ? { status: report.status, evalRunId }
      : { status: 'lease_lost', evalRunId }
  }

  private async monitorHeartbeat(
    identity: EvalRunLeaseIdentity,
    executionAbort: AbortController,
    stopSignal: AbortSignal,
    monitor: { leaseLost: boolean },
  ) {
    while (!stopSignal.aborted) {
      try {
        await abortableSleep(this.options.heartbeatIntervalMs, stopSignal)
      } catch {
        return
      }
      if (stopSignal.aborted) return
      try {
        const result = await this.control.heartbeatRun(identity, this.options.leaseDurationMs)
        if (result === 'lease_lost') {
          monitor.leaseLost = true
          executionAbort.abort()
          return
        }
      } catch {
        // A transient heartbeat error does not prove lease loss. The database
        // expiry and the final fenced commit remain authoritative.
      }
    }
  }
}
