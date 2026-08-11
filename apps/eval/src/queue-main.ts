import { loadEvalQueueConfig } from './queue-config.ts'
import { createEvalQueueRuntime } from './queue-runtime.ts'

async function run() {
  const runtime = createEvalQueueRuntime(loadEvalQueueConfig(process.env))
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

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Eval queue startup failed'
  console.error(JSON.stringify({ level: 'fatal', scope: 'eval.startup', message }))
  process.exitCode = 1
})
