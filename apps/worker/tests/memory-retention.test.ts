import { describe, expect, it, vi } from 'vitest'
import { loadMemoryRetentionMaintenanceConfig } from '../src/config'
import {
  MemoryRetentionMaintenanceService,
  MemoryRetentionProcessRuntime,
  type MemoryRetentionBatchReport,
} from '../src/memory-retention'

function report(overrides: Partial<MemoryRetentionBatchReport> = {}): MemoryRetentionBatchReport {
  return {
    schemaVersion: 1,
    workerId: 'retention-worker-1',
    status: 'idle',
    startedAt: '2026-08-09T00:00:00.000Z',
    finishedAt: '2026-08-09T00:00:00.001Z',
    durationMs: 1,
    batchSize: 100,
    deleted: { sourceSignals: 0, memories: 0, candidates: 0 },
    remaining: {
      sourceSignalsDue: 0,
      memoriesDue: 0,
      candidatesDue: 0,
      sampledTotalDue: 0,
      sampleCapped: false,
      alertThreshold: 1_000,
    },
    ...overrides,
  }
}

describe('Memory retention maintenance service', () => {
  it('expires source-owned data first and reports a versioned bounded backlog snapshot', async () => {
    const calls: string[] = []
    const clock = vi.fn()
      .mockReturnValueOnce(new Date('2026-08-09T00:00:00.000Z'))
      .mockReturnValueOnce(new Date('2026-08-09T00:00:00.025Z'))
    const service = new MemoryRetentionMaintenanceService({
      expireDue: vi.fn(async (limit) => {
        calls.push(`signals:${limit}`)
        return { signalsDeleted: 2 }
      }),
      inspectExpiryBacklog: vi.fn(async (threshold) => {
        calls.push(`signals-backlog:${threshold}`)
        return { signalsDue: 3, signalsCapped: false }
      }),
    }, {
      expireDue: vi.fn(async (limit) => {
        calls.push(`memories:${limit}`)
        return { memoriesDeleted: 1, candidatesDeleted: 4 }
      }),
      inspectExpiryBacklog: vi.fn(async (threshold) => {
        calls.push(`memories-backlog:${threshold}`)
        return {
          memoriesDue: 4,
          memoriesCapped: false,
          candidatesDue: 5,
          candidatesCapped: true,
        }
      }),
    }, {
      workerId: 'retention-worker-1',
      batchSize: 25,
      backlogAlertThreshold: 5,
      clock,
    })
    await expect(service.runBatch()).resolves.toEqual({
      schemaVersion: 1,
      workerId: 'retention-worker-1',
      status: 'backlog_alert',
      startedAt: '2026-08-09T00:00:00.000Z',
      finishedAt: '2026-08-09T00:00:00.025Z',
      durationMs: 25,
      batchSize: 25,
      deleted: { sourceSignals: 2, memories: 1, candidates: 4 },
      remaining: {
        sourceSignalsDue: 3,
        memoriesDue: 4,
        candidatesDue: 5,
        sampledTotalDue: 12,
        sampleCapped: true,
        alertThreshold: 5,
      },
    })
    expect(calls.slice(0, 2)).toEqual(['signals:25', 'memories:25'])
    expect(calls.slice(2).sort()).toEqual([
      'memories-backlog:5',
      'signals-backlog:5',
    ])
  })

  it('validates bounded batch and backlog controls before touching stores', () => {
    const stores = {
      expireDue: vi.fn(),
      inspectExpiryBacklog: vi.fn(),
    }
    expect(() => new MemoryRetentionMaintenanceService(stores, stores as never, {
      workerId: '', batchSize: 100, backlogAlertThreshold: 1_000,
    })).toThrow('workerId')
    expect(() => new MemoryRetentionMaintenanceService(stores, stores as never, {
      workerId: 'worker', batchSize: 1_001, backlogAlertThreshold: 1_000,
    })).toThrow('batchSize')
  })
})

describe('Memory retention process runtime', () => {
  it('checks schema before readiness and drains remaining backlog on the short interval', async () => {
    const calls: string[] = []
    const first = report({
      status: 'progress',
      remaining: {
        ...report().remaining,
        sourceSignalsDue: 1,
        sampledTotalDue: 1,
      },
    })
    const runBatch = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(report())
    const runtime = new MemoryRetentionProcessRuntime({
      startHealth: vi.fn(async () => { calls.push('health:start') }),
      checkDatabase: vi.fn(async () => { calls.push('database:check') }),
      runBatch,
      closeDatabase: vi.fn(async () => { calls.push('database:close') }),
      markReady: vi.fn(() => { calls.push('health:ready') }),
      markDraining: vi.fn(() => { calls.push('health:draining') }),
      closeHealth: vi.fn(async () => { calls.push('health:close') }),
      onBatch: vi.fn(() => { calls.push('batch') }),
      onError: vi.fn(),
    }, { pollMs: 60_000, backlogPollMs: 1 })
    await runtime.start()
    await vi.waitFor(() => expect(runBatch.mock.calls.length).toBeGreaterThanOrEqual(2))
    await runtime.close()
    expect(calls.slice(0, 3)).toEqual(['health:start', 'database:check', 'health:ready'])
    expect(calls.slice(-3)).toEqual([
      'health:draining', 'database:close', 'health:close',
    ])
  })

  it('reports a failed batch and retries without losing readiness', async () => {
    const onError = vi.fn()
    const runBatch = vi.fn()
      .mockRejectedValueOnce(new Error('temporary database error'))
      .mockResolvedValue(report())
    const runtime = new MemoryRetentionProcessRuntime({
      checkDatabase: vi.fn(async () => undefined),
      runBatch,
      closeDatabase: vi.fn(async () => undefined),
      onBatch: vi.fn(),
      onError,
    }, { pollMs: 1, backlogPollMs: 1 })
    await runtime.start()
    await vi.waitFor(() => expect(runBatch.mock.calls.length).toBeGreaterThanOrEqual(2))
    await runtime.close()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'temporary database error',
    }))
  })
})

describe('Memory retention process config', () => {
  const env = {
    MEMORY_RETENTION_MAINTENANCE_ENABLED: 'true',
    DATABASE_MEMORY_RETENTION_URL: 'postgresql://retention-db',
    MEMORY_RETENTION_DATABASE_ROLE: 'vibe_writer_memory_retention',
    MEMORY_RETENTION_WORKER_ID: 'memory-retention-1',
  }

  it('is fail-closed and does not require Redis or model credentials', () => {
    expect(() => loadMemoryRetentionMaintenanceConfig({
      ...env,
      MEMORY_RETENTION_MAINTENANCE_ENABLED: undefined,
    })).toThrow('MEMORY_RETENTION_MAINTENANCE_ENABLED')
    expect(loadMemoryRetentionMaintenanceConfig(env)).toEqual({
      databaseUrl: 'postgresql://retention-db',
      databaseRole: 'vibe_writer_memory_retention',
      workerId: 'memory-retention-1',
      batchSize: 100,
      backlogAlertThreshold: 1_000,
      pollMs: 60_000,
      backlogPollMs: 250,
    })
  })

  it('does not fall back to the general owner connection or an unnamed role', () => {
    expect(() => loadMemoryRetentionMaintenanceConfig({
      ...env,
      DATABASE_MEMORY_RETENTION_URL: undefined,
      DATABASE_URL: 'postgresql://owner-must-not-be-used',
    })).toThrow('DATABASE_MEMORY_RETENTION_URL')
    expect(() => loadMemoryRetentionMaintenanceConfig({
      ...env,
      MEMORY_RETENTION_DATABASE_ROLE: undefined,
    })).toThrow('MEMORY_RETENTION_DATABASE_ROLE')
  })

  it('bounds batch, alert, drain cadence and optional health listener', () => {
    expect(loadMemoryRetentionMaintenanceConfig({
      ...env,
      MEMORY_RETENTION_BATCH_SIZE: '500',
      MEMORY_RETENTION_BACKLOG_ALERT_THRESHOLD: '2000',
      MEMORY_RETENTION_POLL_MS: '10000',
      MEMORY_RETENTION_BACKLOG_POLL_MS: '50',
      MEMORY_RETENTION_HEALTH_HOST: '127.0.0.1',
      MEMORY_RETENTION_HEALTH_PORT: '3201',
    })).toMatchObject({
      batchSize: 500,
      backlogAlertThreshold: 2_000,
      pollMs: 10_000,
      backlogPollMs: 50,
      health: { host: '127.0.0.1', port: 3201 },
    })
    expect(() => loadMemoryRetentionMaintenanceConfig({
      ...env,
      MEMORY_RETENTION_POLL_MS: '100',
      MEMORY_RETENTION_BACKLOG_POLL_MS: '101',
    })).toThrow('cannot exceed')
  })
})
