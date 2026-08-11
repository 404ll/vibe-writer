import type { ConnectionOptions } from 'bullmq'

export type WorkerRole = 'all' | 'dispatcher' | 'consumer'

export type WorkerDatabaseConfig = {
  url: string
  role: string
}

export type ProductionWorkerConfig = {
  role: WorkerRole
  dispatcherDatabase?: WorkerDatabaseConfig
  consumerDatabase?: WorkerDatabaseConfig
  redis: ConnectionOptions
  anthropicApiKey?: string
  anthropicBaseUrl?: string
  modelId?: string
  tavilyApiKey?: string
  tavilyBaseUrl?: string
  codeRevision: string
  workerId: string
  queueName: string
  queuePrefix?: string
  concurrency: number
  leaseDurationMs: number
  heartbeatIntervalMs: number
  lockDurationMs: number
  dispatchPollMs: number
  dispatchBatchSize: number
  health?: {
    host: string
    port: number
  }
}

export type MemoryRetentionMaintenanceConfig = {
  databaseUrl: string
  databaseRole: string
  workerId: string
  batchSize: number
  backlogAlertThreshold: number
  pollMs: number
  backlogPollMs: number
  health?: {
    host: string
    port: number
  }
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
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function optionalPort(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return value
}

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl)
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://')
  const database = url.pathname === '' || url.pathname === '/' ? 0 : Number(url.pathname.slice(1))
  if (!Number.isInteger(database) || database < 0) throw new Error('REDIS_URL database must be a non-negative integer')
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

export function loadProductionWorkerConfig(env: NodeJS.ProcessEnv): ProductionWorkerConfig {
  if (env.DURABLE_WORKER_ENABLED !== 'true') throw new Error('DURABLE_WORKER_ENABLED must equal true')
  const role = (env.DURABLE_WORKER_ROLE?.trim() || 'all') as WorkerRole
  if (!['all', 'dispatcher', 'consumer'].includes(role)) throw new Error('DURABLE_WORKER_ROLE must be all, dispatcher, or consumer')
  const dispatcher = role === 'all' || role === 'dispatcher'
  const consumer = role === 'all' || role === 'consumer'
  const leaseDurationMs = positiveInt(env, 'WORKER_LEASE_DURATION_MS', 60_000)
  const heartbeatIntervalMs = positiveInt(env, 'WORKER_HEARTBEAT_INTERVAL_MS', 15_000)
  const healthPort = optionalPort(env, 'WORKER_HEALTH_PORT')
  if (!healthPort && env.WORKER_HEALTH_HOST?.trim()) {
    throw new Error('WORKER_HEALTH_PORT is required when WORKER_HEALTH_HOST is set')
  }
  if (heartbeatIntervalMs >= leaseDurationMs) throw new Error('Worker heartbeat must be shorter than its lease')
  const dispatcherDatabase = dispatcher ? {
    url: required(env, 'DATABASE_WRITE_DISPATCHER_URL'),
    role: required(env, 'WRITE_DISPATCHER_DATABASE_ROLE'),
  } : undefined
  const consumerDatabase = consumer ? {
    url: required(env, 'DATABASE_WRITE_CONSUMER_URL'),
    role: required(env, 'WRITE_CONSUMER_DATABASE_ROLE'),
  } : undefined
  if (
    dispatcherDatabase && consumerDatabase &&
    dispatcherDatabase.url === consumerDatabase.url
  ) {
    throw new Error('Write dispatcher and consumer database URLs must be distinct')
  }
  if (
    dispatcherDatabase && consumerDatabase &&
    dispatcherDatabase.role === consumerDatabase.role
  ) {
    throw new Error('Write dispatcher and consumer database roles must be distinct')
  }
  return {
    role,
    ...(dispatcherDatabase ? { dispatcherDatabase } : {}),
    ...(consumerDatabase ? { consumerDatabase } : {}),
    redis: redisConnection(required(env, 'REDIS_URL')),
    ...(consumer ? {
      anthropicApiKey: required(env, 'ANTHROPIC_API_KEY'),
      modelId: required(env, 'MODEL_ID'),
    } : {}),
    ...(env.ANTHROPIC_BASE_URL?.trim() ? { anthropicBaseUrl: env.ANTHROPIC_BASE_URL.trim() } : {}),
    ...(env.TAVILY_API_KEY?.trim() ? { tavilyApiKey: env.TAVILY_API_KEY.trim() } : {}),
    ...(env.TAVILY_BASE_URL?.trim() ? { tavilyBaseUrl: env.TAVILY_BASE_URL.trim() } : {}),
    codeRevision: required(env, 'CODE_REVISION'),
    workerId: required(env, 'WORKER_ID'),
    queueName: env.WRITE_QUEUE_NAME?.trim() || 'vibe-writer-write',
    ...(env.BULLMQ_PREFIX?.trim() ? { queuePrefix: env.BULLMQ_PREFIX.trim() } : {}),
    concurrency: positiveInt(env, 'WORKER_CONCURRENCY', 2),
    leaseDurationMs,
    heartbeatIntervalMs,
    lockDurationMs: positiveInt(env, 'BULLMQ_LOCK_DURATION_MS', 120_000),
    dispatchPollMs: positiveInt(env, 'OUTBOX_POLL_MS', 500),
    dispatchBatchSize: positiveInt(env, 'OUTBOX_BATCH_SIZE', 50),
    ...(healthPort ? {
      health: {
        host: env.WORKER_HEALTH_HOST?.trim() || '0.0.0.0',
        port: healthPort,
      },
    } : {}),
  }
}

export function loadMemoryRetentionMaintenanceConfig(
  env: NodeJS.ProcessEnv,
): MemoryRetentionMaintenanceConfig {
  if (env.MEMORY_RETENTION_MAINTENANCE_ENABLED !== 'true') {
    throw new Error('MEMORY_RETENTION_MAINTENANCE_ENABLED must equal true')
  }
  const healthPort = optionalPort(env, 'MEMORY_RETENTION_HEALTH_PORT')
  if (!healthPort && env.MEMORY_RETENTION_HEALTH_HOST?.trim()) {
    throw new Error(
      'MEMORY_RETENTION_HEALTH_PORT is required when MEMORY_RETENTION_HEALTH_HOST is set',
    )
  }
  const pollMs = positiveInt(env, 'MEMORY_RETENTION_POLL_MS', 60_000)
  const backlogPollMs = positiveInt(env, 'MEMORY_RETENTION_BACKLOG_POLL_MS', 250)
  if (backlogPollMs > pollMs) {
    throw new Error('MEMORY_RETENTION_BACKLOG_POLL_MS cannot exceed MEMORY_RETENTION_POLL_MS')
  }
  const batchSize = positiveInt(env, 'MEMORY_RETENTION_BATCH_SIZE', 100)
  if (batchSize > 1_000) throw new Error('MEMORY_RETENTION_BATCH_SIZE cannot exceed 1000')
  const backlogAlertThreshold = positiveInt(
    env,
    'MEMORY_RETENTION_BACKLOG_ALERT_THRESHOLD',
    1_000,
  )
  if (backlogAlertThreshold > 10_000) {
    throw new Error('MEMORY_RETENTION_BACKLOG_ALERT_THRESHOLD cannot exceed 10000')
  }
  return {
    databaseUrl: required(env, 'DATABASE_MEMORY_RETENTION_URL'),
    databaseRole: required(env, 'MEMORY_RETENTION_DATABASE_ROLE'),
    workerId: required(env, 'MEMORY_RETENTION_WORKER_ID'),
    batchSize,
    backlogAlertThreshold,
    pollMs,
    backlogPollMs,
    ...(healthPort ? {
      health: {
        host: env.MEMORY_RETENTION_HEALTH_HOST?.trim() || '0.0.0.0',
        port: healthPort,
      },
    } : {}),
  }
}
