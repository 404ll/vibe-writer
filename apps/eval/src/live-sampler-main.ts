import { runLiveEvalSampler } from './live-sampler-runtime.ts'

void runLiveEvalSampler().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Live Eval sampler startup failed'
  console.error(JSON.stringify({ level: 'fatal', scope: 'eval.live-sampler.startup', message }))
  process.exitCode = 1
})
