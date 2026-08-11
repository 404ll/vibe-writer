import {
  createMemoryRepository,
  createMemorySourceSignalRepository,
  createPostgresDatabase,
} from '@vibe-writer/db'
import { assertCurrentMemoryRetentionRole } from '@vibe-writer/db/memory-retention-role'
import {
  loadMemoryRetentionMaintenanceConfig,
  type MemoryRetentionMaintenanceConfig,
} from './config'
import { WorkerHealthServer } from './health-server'
import {
  MemoryRetentionMaintenanceService,
  MemoryRetentionProcessRuntime,
  type MemoryRetentionBatchReport,
} from './memory-retention'

function reportBatch(report: MemoryRetentionBatchReport): void {
  if (report.status === 'idle') return
  console.info(JSON.stringify({ level: report.status === 'backlog_alert' ? 'warn' : 'info',
    scope: 'memory.retention.batch', ...report }))
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown Memory retention error'
  console.error(JSON.stringify({ level: 'error', scope: 'memory.retention.batch', message }))
}

export function createMemoryRetentionMaintenanceRuntime(
  config: MemoryRetentionMaintenanceConfig,
) {
  const database = createPostgresDatabase(config.databaseUrl, { max: 4 })
  const health = config.health ? new WorkerHealthServer(config.health) : null
  const service = new MemoryRetentionMaintenanceService(
    createMemorySourceSignalRepository(database.db),
    createMemoryRepository(database.db),
    {
      workerId: config.workerId,
      batchSize: config.batchSize,
      backlogAlertThreshold: config.backlogAlertThreshold,
    },
  )
  return new MemoryRetentionProcessRuntime({
    ...(health ? {
      startHealth: () => health.start(),
      markReady: () => health.markReady(),
      markDraining: () => health.markDraining(),
      closeHealth: () => health.close(),
    } : {}),
    checkDatabase: async () => {
      await assertCurrentMemoryRetentionRole(database.client, config.databaseRole)
      const [result] = await database.client<{ ready: boolean }[]>`
        select (
          to_regclass('public.memory_source_signals') is not null
          and to_regclass('public.memory_source_signal_tombstones') is not null
          and to_regclass('public.memory_extraction_tasks') is not null
          and to_regclass('public.memory_extraction_attempts') is not null
          and to_regclass('public.memory_extraction_effects') is not null
          and to_regclass('public.memory_candidates') is not null
          and to_regclass('public.memory_candidate_events') is not null
          and to_regclass('public.memories') is not null
          and to_regclass('public.memory_revisions') is not null
          and to_regclass('public.memory_tombstones') is not null
          and to_regclass('public.outbox_events') is not null
        ) as ready
      `
      if (result?.ready !== true) {
        throw new Error('Memory retention durable database schema is incomplete')
      }
    },
    runBatch: () => service.runBatch(),
    closeDatabase: () => database.close(),
    onBatch: reportBatch,
    onError: reportError,
  }, {
    pollMs: config.pollMs,
    backlogPollMs: config.backlogPollMs,
  })
}

export async function runMemoryRetentionMaintenance(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runtime = createMemoryRetentionMaintenanceRuntime(
    loadMemoryRetentionMaintenanceConfig(env),
  )
  try {
    await runtime.start()
  } catch (error) {
    await runtime.close()
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void runtime.close().then(resolve, reject)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
