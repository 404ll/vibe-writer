import {
  assertCurrentEvalRuntimeRole,
  createEvalSamplingRepository,
  createPostgresDatabase,
} from '@vibe-writer/db'
import type { LiveEvalSamplerConfig } from './live-sampler-config.ts'
import { LiveEvalSamplerLoop } from './live-sampler.ts'

function report(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown live Eval sampler error'
  console.error(JSON.stringify({ level: 'error', scope: 'eval.live-sampler', message }))
}

export function createLiveEvalSamplerRuntime(config: LiveEvalSamplerConfig) {
  const database = createPostgresDatabase(config.database.url, { max: 4 })
  const loop = new LiveEvalSamplerLoop(
    createEvalSamplingRepository(database.db),
    {
      pollIntervalMs: config.pollIntervalMs,
      policyLimit: config.policyLimit,
      sourceBatchSize: config.sourceBatchSize,
      onError: report,
    },
  )
  let started = false
  let closed = false
  return {
    async start() {
      if (started) throw new Error('Live Eval sampler runtime already started')
      started = true
      await assertCurrentEvalRuntimeRole(
        database.client,
        'live-sampler',
        config.database.role,
      )
      const [schema] = await database.client<{ ready: boolean }[]>`
        select (
          to_regclass('public.eval_sampling_policies') is not null
          and to_regclass('public.eval_candidates') is not null
          and to_regclass('public.eval_candidate_events') is not null
          and to_regclass('public.runs') is not null
          and to_regclass('public.articles') is not null
        ) as ready
      `
      if (schema?.ready !== true) {
        throw new Error('Live Eval sampler database schema is incomplete')
      }
      await loop.start()
    },
    async close() {
      if (closed) return
      closed = true
      await loop.close()
      await database.close()
    },
  }
}

export async function runLiveEvalSampler(env: NodeJS.ProcessEnv = process.env) {
  const { loadLiveEvalSamplerConfig } = await import('./live-sampler-config.ts')
  const runtime = createLiveEvalSamplerRuntime(loadLiveEvalSamplerConfig(env))
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
