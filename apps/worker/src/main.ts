import { runProductionWorker } from './production'

runProductionWorker().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Worker startup failed'
  console.error(JSON.stringify({ level: 'fatal', scope: 'worker.startup', message }))
  process.exitCode = 1
})
