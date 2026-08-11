import type {
  ClaimJobInput,
  CompleteClaimInput,
  CompleteClaimResult,
  JobStatus,
  LeaseHeartbeatResult,
  LeaseIdentity,
  PauseClaimInput,
  PauseClaimResult,
  TerminateClaimInput,
  TerminateClaimResult,
} from '@vibe-writer/db'
import type { ClaimedJob, WorkerLeaseControl } from './runner'

export type WorkerJobControlSource = {
  claimJob(input: ClaimJobInput): Promise<ClaimedJob | null>
  getJob(jobId: string): Promise<{ status: JobStatus } | null>
  heartbeatClaim(
    identity: LeaseIdentity,
    leaseDurationMs: number,
  ): Promise<LeaseHeartbeatResult>
}

export type WorkerTerminalControlSource = {
  completeClaim(input: CompleteClaimInput): Promise<CompleteClaimResult>
  terminateClaim(input: TerminateClaimInput): Promise<TerminateClaimResult>
  pauseClaim(input: PauseClaimInput): Promise<PauseClaimResult>
}

export function createWorkerLeaseControl(
  jobs: WorkerJobControlSource,
  terminals: WorkerTerminalControlSource,
): WorkerLeaseControl {
  return {
    claimJob: (input) => jobs.claimJob(input),
    getJob: (jobId) => jobs.getJob(jobId),
    heartbeatClaim: (identity, leaseDurationMs) =>
      jobs.heartbeatClaim(identity, leaseDurationMs),
    completeClaim: (input) => terminals.completeClaim(input),
    terminateClaim: (input) => terminals.terminateClaim(input),
    pauseClaim: (input) => terminals.pauseClaim(input),
  }
}
