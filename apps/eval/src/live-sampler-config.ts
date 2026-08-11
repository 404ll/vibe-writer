export type LiveEvalSamplerConfig = {
  database: {
    url: string
    role: string
  }
  pollIntervalMs: number
  policyLimit: number
  sourceBatchSize: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function loadLiveEvalSamplerConfig(env: NodeJS.ProcessEnv): LiveEvalSamplerConfig {
  if (env.EVAL_LIVE_SAMPLER_ENABLED !== 'true') {
    throw new Error('EVAL_LIVE_SAMPLER_ENABLED must equal true')
  }
  return {
    database: {
      url: required(env, 'DATABASE_EVAL_LIVE_SAMPLER_URL'),
      role: required(env, 'EVAL_LIVE_SAMPLER_DATABASE_ROLE'),
    },
    pollIntervalMs: positiveInteger(env, 'EVAL_LIVE_SAMPLER_POLL_MS', 5_000),
    policyLimit: positiveInteger(env, 'EVAL_LIVE_SAMPLER_POLICY_LIMIT', 20),
    sourceBatchSize: positiveInteger(env, 'EVAL_LIVE_SAMPLER_SOURCE_BATCH_SIZE', 100),
  }
}
