import type { ConnectionOptions } from 'bullmq'
import type {
  EvalModelBudgetLimits,
  ModelGraderProfile,
  ModelPricingSnapshot,
} from '@vibe-writer/eval-graders'
import { DEFAULT_EVAL_QUEUE_NAME } from './queue-protocol.ts'

export type EvalQueueRole = 'all' | 'dispatcher' | 'consumer'

export type EvalDatabaseConfig = {
  url: string
  role: string
}

export type EvalQueueConfig = {
  role: EvalQueueRole
  dispatcherDatabase?: EvalDatabaseConfig
  consumerDatabase?: EvalDatabaseConfig
  redis: ConnectionOptions
  workerId: string
  queueName: string
  queuePrefix?: string
  concurrency: number
  leaseDurationMs: number
  heartbeatIntervalMs: number
  lockDurationMs: number
  dispatchPollMs: number
  dispatchBatchSize: number
  grader: LiveGraderConfig | null
  memoryCalibration: MemoryCalibrationWorkerConfig | null
}

export type MemoryCalibrationWorkerConfig = {
  anthropic: {
    apiKey: string
    model: string
    baseUrl?: string
    timeoutMs: number
  }
}

export type LiveGraderConfig = {
  codeRevision: string
  anthropic: {
    apiKey: string
    model: string
    baseUrl?: string
    timeoutMs: number
  }
  profile: ModelGraderProfile
  pricing: ModelPricingSnapshot
  budget: EvalModelBudgetLimits
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function requiredPositiveInt(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function requiredNonnegativeInt(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function loadLiveGraderConfig(env: NodeJS.ProcessEnv): LiveGraderConfig | null {
  if (env.EVAL_GRADER_ENABLED !== 'true') return null
  return {
    codeRevision: required(env, 'EVAL_CODE_REVISION'),
    anthropic: {
      apiKey: required(env, 'EVAL_GRADER_ANTHROPIC_API_KEY'),
      model: required(env, 'EVAL_GRADER_ANTHROPIC_MODEL'),
      ...(env.EVAL_GRADER_ANTHROPIC_BASE_URL?.trim()
        ? { baseUrl: env.EVAL_GRADER_ANTHROPIC_BASE_URL.trim() }
        : {}),
      timeoutMs: positiveInt(env, 'EVAL_GRADER_TIMEOUT_MS', 120_000),
    },
    profile: {
      key: required(env, 'EVAL_GRADER_KEY'),
      version: required(env, 'EVAL_GRADER_VERSION'),
      modelProfile: required(env, 'EVAL_GRADER_MODEL_PROFILE'),
      promptVersion: required(env, 'EVAL_GRADER_PROMPT_VERSION'),
      maxOutputTokens: requiredPositiveInt(env, 'EVAL_GRADER_MAX_OUTPUT_TOKENS'),
    },
    pricing: {
      version: required(env, 'EVAL_GRADER_PRICING_VERSION'),
      inputMicrousdPerMillionTokens: requiredNonnegativeInt(
        env,
        'EVAL_GRADER_INPUT_MICROUSD_PER_MTOK',
      ),
      outputMicrousdPerMillionTokens: requiredNonnegativeInt(
        env,
        'EVAL_GRADER_OUTPUT_MICROUSD_PER_MTOK',
      ),
      cacheReadMicrousdPerMillionTokens: requiredNonnegativeInt(
        env,
        'EVAL_GRADER_CACHE_READ_MICROUSD_PER_MTOK',
      ),
      cacheWriteMicrousdPerMillionTokens: requiredNonnegativeInt(
        env,
        'EVAL_GRADER_CACHE_WRITE_MICROUSD_PER_MTOK',
      ),
    },
    budget: {
      maxCalls: requiredPositiveInt(env, 'EVAL_GRADER_MAX_CALLS_PER_RUN'),
      maxCostMicrousd: requiredPositiveInt(env, 'EVAL_GRADER_MAX_COST_MICROUSD_PER_RUN'),
    },
  }
}

export function loadMemoryCalibrationWorkerConfig(
  env: NodeJS.ProcessEnv,
): MemoryCalibrationWorkerConfig | null {
  if (env.EVAL_MEMORY_CALIBRATION_ENABLED !== 'true') return null
  return {
    anthropic: {
      apiKey: required(env, 'EVAL_MEMORY_CALIBRATION_ANTHROPIC_API_KEY'),
      model: required(env, 'EVAL_MEMORY_CALIBRATION_ANTHROPIC_MODEL'),
      ...(env.EVAL_MEMORY_CALIBRATION_ANTHROPIC_BASE_URL?.trim()
        ? { baseUrl: env.EVAL_MEMORY_CALIBRATION_ANTHROPIC_BASE_URL.trim() }
        : {}),
      timeoutMs: positiveInt(env, 'EVAL_MEMORY_CALIBRATION_TIMEOUT_MS', 120_000),
    },
  }
}

export function evalRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl)
  if (!['redis:', 'rediss:'].includes(url.protocol)) {
    throw new Error('EVAL_REDIS_URL must use redis:// or rediss://')
  }
  const database = url.pathname === '' || url.pathname === '/' ? 0 : Number(url.pathname.slice(1))
  if (!Number.isInteger(database) || database < 0) {
    throw new Error('EVAL_REDIS_URL database must be a non-negative integer')
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: database,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  }
}

export function loadEvalQueueConfig(env: NodeJS.ProcessEnv): EvalQueueConfig {
  if (env.EVAL_QUEUE_ENABLED !== 'true') {
    throw new Error('EVAL_QUEUE_ENABLED must equal true')
  }
  const role = (env.EVAL_QUEUE_ROLE?.trim() || 'all') as EvalQueueRole
  if (!['all', 'dispatcher', 'consumer'].includes(role)) {
    throw new Error('EVAL_QUEUE_ROLE must be all, dispatcher, or consumer')
  }
  const dispatcher = role === 'all' || role === 'dispatcher'
  const consumer = role === 'all' || role === 'consumer'
  const leaseDurationMs = positiveInt(env, 'EVAL_LEASE_DURATION_MS', 60_000)
  const heartbeatIntervalMs = positiveInt(env, 'EVAL_HEARTBEAT_INTERVAL_MS', 15_000)
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new Error('Eval heartbeat must be shorter than its lease')
  }
  const queueName = env.EVAL_QUEUE_NAME?.trim() || DEFAULT_EVAL_QUEUE_NAME
  if (queueName === 'vibe-writer-write') {
    throw new Error('Eval and write workloads must use different queue names')
  }
  const dispatcherDatabase = dispatcher ? {
    url: required(env, 'DATABASE_EVAL_DISPATCHER_URL'),
    role: required(env, 'EVAL_DISPATCHER_DATABASE_ROLE'),
  } : undefined
  const consumerDatabase = consumer ? {
    url: required(env, 'DATABASE_EVAL_CONSUMER_URL'),
    role: required(env, 'EVAL_CONSUMER_DATABASE_ROLE'),
  } : undefined
  if (
    dispatcherDatabase && consumerDatabase &&
    dispatcherDatabase.url === consumerDatabase.url
  ) {
    throw new Error('Eval dispatcher and consumer database URLs must be distinct')
  }
  if (
    dispatcherDatabase && consumerDatabase &&
    dispatcherDatabase.role === consumerDatabase.role
  ) {
    throw new Error('Eval dispatcher and consumer database roles must be distinct')
  }
  return {
    role,
    ...(dispatcherDatabase ? { dispatcherDatabase } : {}),
    ...(consumerDatabase ? { consumerDatabase } : {}),
    redis: evalRedisConnection(required(env, 'EVAL_REDIS_URL')),
    workerId: required(env, 'EVAL_WORKER_ID'),
    queueName,
    ...(env.EVAL_BULLMQ_PREFIX?.trim()
      ? { queuePrefix: env.EVAL_BULLMQ_PREFIX.trim() }
      : {}),
    concurrency: positiveInt(env, 'EVAL_WORKER_CONCURRENCY', 2),
    leaseDurationMs,
    heartbeatIntervalMs,
    lockDurationMs: positiveInt(env, 'EVAL_BULLMQ_LOCK_DURATION_MS', 120_000),
    dispatchPollMs: positiveInt(env, 'EVAL_OUTBOX_POLL_MS', 500),
    dispatchBatchSize: positiveInt(env, 'EVAL_OUTBOX_BATCH_SIZE', 50),
    grader: consumer ? loadLiveGraderConfig(env) : null,
    memoryCalibration: consumer ? loadMemoryCalibrationWorkerConfig(env) : null,
  }
}
