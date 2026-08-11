import type {
  ClaimJobInput,
  LeaseHeartbeatResult,
  LeaseIdentity,
} from '@vibe-writer/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkerJobRunner,
  type ClaimedJob,
  type WorkerExecutor,
  type WorkerExecutionResult,
  type WorkerLeaseControl,
} from '../src'

const execution = {
  modelProfile: { profile: 'test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'graph-v1',
  toolVersions: { writer: 'writer-v1' },
  codeRevision: 'test-revision',
}

const claim: ClaimedJob = {
  job: {
    id: 'job-1',
    topic: 'Durable worker',
    style: '',
    targetWords: null,
    intervention: { on_outline: false },
  },
  run: { id: 'run-1', ...execution },
  leaseToken: 'lease-1',
}

const completedExecution = {
  status: 'completed',
  exportIntent: {
    idempotencyKey: 'job:job-1:article:export',
    markdown: '# Durable worker\n\nBody',
  },
} satisfies WorkerExecutionResult

function control(overrides: Partial<WorkerLeaseControl> = {}): WorkerLeaseControl {
  return {
    claimJob: vi.fn(async (_input: ClaimJobInput) => claim),
    getJob: vi.fn(async () => ({ status: 'completed' as const })),
    heartbeatClaim: vi.fn(
      async (_identity: LeaseIdentity, _duration: number): Promise<LeaseHeartbeatResult> =>
        'renewed',
    ),
    completeClaim: vi.fn(async () => ({
      status: 'committed' as const,
      article: {} as never,
      event: {
        event: 'done' as const,
        data: { output_path: null, article_id: 'article-1', _seq: 0 },
      },
    })),
    terminateClaim: vi.fn(async (input) => ({
      status: 'settled' as const,
      event:
        input.outcome === 'failed'
          ? { event: 'error' as const, data: { message: input.errorMessage, _seq: 0 } }
          : { event: 'cancelled' as const, data: { _seq: 0 } },
    })),
    pauseClaim: vi.fn(async (input) => ({
      status: 'paused' as const,
      event: { event: 'outline_ready' as const, data: { outline: input.outline, _seq: 0 } },
    })),
    ...overrides,
  }
}

function runner(
  leaseControl: WorkerLeaseControl,
  executor: WorkerExecutor,
): WorkerJobRunner {
  return new WorkerJobRunner(leaseControl, executor, {
    workerId: 'worker-a',
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    execution,
  })
}

function waitsForAbort(): WorkerExecutor {
  return {
    execute: vi.fn(
      ({ signal }) =>
        new Promise<WorkerExecutionResult>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
        }),
    ),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkerJobRunner', () => {
  it('returns not_claimed without executing duplicate delivery', async () => {
    const leaseControl = control({ claimJob: vi.fn(async () => null) })
    const executor = { execute: vi.fn(async () => completedExecution) }

    await expect(runner(leaseControl, executor).run('job-1')).resolves.toEqual({
      status: 'not_claimed',
      reason: 'terminal',
    })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(leaseControl.completeClaim).not.toHaveBeenCalled()
  })

  it('distinguishes a busy duplicate from terminal and missing deliveries', async () => {
    const executor = { execute: vi.fn(async () => completedExecution) }
    const busy = control({
      claimJob: vi.fn(async () => null),
      getJob: vi.fn(async () => ({ status: 'running' as const })),
    })
    await expect(runner(busy, executor).run('job-1')).resolves.toEqual({
      status: 'not_claimed',
      reason: 'busy',
    })

    const missing = control({
      claimJob: vi.fn(async () => null),
      getJob: vi.fn(async () => null),
    })
    await expect(runner(missing, executor).run('job-1')).resolves.toEqual({
      status: 'not_claimed',
      reason: 'not_found',
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('settles a successful execution with the claimed fencing token', async () => {
    const leaseControl = control()
    const executor = { execute: vi.fn(async () => completedExecution) }

    await expect(runner(leaseControl, executor).run('job-1')).resolves.toEqual({
      status: 'completed',
      runId: 'run-1',
    })
    expect(leaseControl.completeClaim).toHaveBeenCalledWith({
      jobId: 'job-1',
      runId: 'run-1',
      leaseToken: 'lease-1',
      exportIdempotencyKey: 'job:job-1:article:export',
      topic: 'Durable worker',
      markdown: '# Durable worker\n\nBody',
      outputPath: null,
      requestMemoryExtraction: false,
    })
  })

  it('renews the lease while execution is active', async () => {
    vi.useFakeTimers()
    const leaseControl = control()
    let finish!: () => void
    const executor = {
      execute: vi.fn(
        () =>
          new Promise<WorkerExecutionResult>((resolve) => {
            finish = () => resolve(completedExecution)
          }),
      ),
    }
    const running = runner(leaseControl, executor).run('job-1')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(leaseControl.heartbeatClaim).toHaveBeenCalledTimes(1)
    finish()
    await expect(running).resolves.toMatchObject({ status: 'completed' })
  })

  it('aborts and settles cancelled when heartbeat observes a cancel request', async () => {
    vi.useFakeTimers()
    const leaseControl = control({
      heartbeatClaim: vi.fn<WorkerLeaseControl['heartbeatClaim']>(
        async () => 'cancel_requested',
      ),
    })
    const executor = waitsForAbort()
    const running = runner(leaseControl, executor).run('job-1')

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(running).resolves.toEqual({ status: 'cancelled', runId: 'run-1' })
    expect(leaseControl.terminateClaim).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cancelled', leaseToken: 'lease-1' }),
    )
  })

  it('aborts without settling after lease loss', async () => {
    vi.useFakeTimers()
    const leaseControl = control({
      heartbeatClaim: vi.fn<WorkerLeaseControl['heartbeatClaim']>(
        async () => 'lease_lost',
      ),
    })
    const running = runner(leaseControl, waitsForAbort()).run('job-1')

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(running).resolves.toEqual({ status: 'lease_lost', runId: 'run-1' })
    expect(leaseControl.terminateClaim).not.toHaveBeenCalled()
  })

  it('fails closed when the heartbeat repository throws', async () => {
    vi.useFakeTimers()
    const leaseControl = control({
      heartbeatClaim: vi.fn<WorkerLeaseControl['heartbeatClaim']>(async () => {
        throw new Error('database unavailable')
      }),
    })
    const running = runner(leaseControl, waitsForAbort()).run('job-1')

    await vi.advanceTimersByTimeAsync(10_000)
    await expect(running).resolves.toEqual({ status: 'lease_lost', runId: 'run-1' })
    expect(leaseControl.terminateClaim).not.toHaveBeenCalled()
  })

  it('fences exception settlement when ownership changed', async () => {
    const leaseControl = control({
      terminateClaim: vi.fn(async () => ({ status: 'lease_lost' as const })),
    })
    const executor = {
      execute: vi.fn(async () => {
        throw new Error('provider failed')
      }),
    }

    await expect(runner(leaseControl, executor).run('job-1')).resolves.toEqual({
      status: 'lease_lost',
      runId: 'run-1',
    })
    expect(leaseControl.terminateClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        errorCode: 'execution_failed',
        errorMessage: 'Worker execution failed.',
      }),
    )
  })

  it('settles a sanitized terminal failure while the lease is active', async () => {
    const leaseControl = control()
    const executor = {
      execute: vi.fn(async () => {
        throw new Error('secret provider response')
      }),
    }

    await expect(runner(leaseControl, executor).run('job-1')).resolves.toEqual({
      status: 'failed',
      runId: 'run-1',
      errorCode: 'execution_failed',
    })
    expect(leaseControl.terminateClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        errorCode: 'execution_failed',
        errorMessage: 'Worker execution failed.',
      }),
    )
  })

  it('projects an outline interrupt without marking the job completed', async () => {
    const leaseControl = control()
    const executor = {
      execute: vi.fn(async () => ({
        status: 'awaiting_input' as const,
        interruptId: 'interrupt-outline-1',
        outline: ['第一章'],
      })),
    }

    await expect(runner(leaseControl, executor).run('job-1')).resolves.toEqual({
      status: 'awaiting_input',
      runId: 'run-1',
    })
    expect(leaseControl.pauseClaim).toHaveBeenCalledWith({
      jobId: 'job-1',
      runId: 'run-1',
      leaseToken: 'lease-1',
      interruptId: 'interrupt-outline-1',
      outline: ['第一章'],
    })
    expect(leaseControl.completeClaim).not.toHaveBeenCalled()
  })

  it('settles cancelled when cancellation races with successful completion', async () => {
    const leaseControl = control({
      completeClaim: vi
        .fn<WorkerLeaseControl['completeClaim']>()
        .mockResolvedValueOnce({ status: 'cancel_requested' }),
      terminateClaim: vi.fn(async () => ({
        status: 'settled' as const,
        event: { event: 'cancelled' as const, data: { _seq: 0 } },
      })),
    })
    const executor = { execute: vi.fn(async () => completedExecution) }

    await expect(runner(leaseControl, executor).run('job-1')).resolves.toEqual({
      status: 'cancelled',
      runId: 'run-1',
    })
    expect(leaseControl.terminateClaim).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'cancelled', leaseToken: 'lease-1' }),
    )
  })
})
