import { runMemoryRetentionMaintenance } from './memory-retention-production'

runMemoryRetentionMaintenance().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Memory retention startup failed'
  console.error(JSON.stringify({ level: 'fatal', scope: 'memory.retention.startup', message }))
  process.exitCode = 1
})
