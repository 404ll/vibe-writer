import type { ConnectionOptions } from 'bullmq'

export type WorkerRole = 'all' | 'dispatcher' | 'consumer'
export type WorkerConsumerAccessMode = 'cross-workspace' | 'single-workspace'
export type WebSearchProviderName = 'disabled' | 'tavily' | 'brave' | 'searxng'

export type WorkerDatabaseConfig = {
  url: string
  role: string
}

export type ProductionWorkerConfig = {
  role: WorkerRole
  dispatcherDatabase?: WorkerDatabaseConfig
  consumerDatabase?: WorkerDatabaseConfig
  consumerAccessMode: WorkerConsumerAccessMode
  singleWorkspaceId?: string
  singlePrincipalId?: string
  redis: ConnectionOptions
  anthropicApiKey?: string
  anthropicBaseUrl?: string
  anthropicThinkingMode?: 'enabled' | 'disabled'
  modelId?: string
  tavilyApiKey?: string
  tavilyBaseUrl?: string
  braveSearchApiKey?: string
  braveSearchBaseUrl?: string
  searxngUrl?: string
  webSearchProvider: WebSearchProviderName
  webExtractEnabled: boolean
  webExtractTimeoutMs: number
  webExtractMaxResponseBytes: number
  webExtractMaxTextChars: number
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

/** Run snapshot 只记录可复现实质行为的配置，不记录 endpoint 或 credential。 */
export function webResearchToolVersions(config: Pick<
  ProductionWorkerConfig,
  | 'webSearchProvider'
  | 'webExtractEnabled'
  | 'webExtractTimeoutMs'
  | 'webExtractMaxResponseBytes'
  | 'webExtractMaxTextChars'
>): Record<string, string> {
  return {
    search: `${config.webSearchProvider}-search-v1`,
    webExtract: config.webExtractEnabled
      ? [
          'readability-v1',
          `timeout-${config.webExtractTimeoutMs}`,
          `bytes-${config.webExtractMaxResponseBytes}`,
          `chars-${config.webExtractMaxTextChars}`,
        ].join(':')
      : 'disabled-v1',
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

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must equal true or false`)
}

function webSearchProvider(env: NodeJS.ProcessEnv): WebSearchProviderName {
  const configured = env.WEB_SEARCH_PROVIDER?.trim()
  if (configured && !['disabled', 'tavily', 'brave', 'searxng'].includes(configured)) {
    throw new Error('WEB_SEARCH_PROVIDER must be disabled, tavily, brave, or searxng')
  }
  const provider = (configured || (
    env.TAVILY_API_KEY?.trim()
      ? 'tavily'
      : env.BRAVE_SEARCH_API_KEY?.trim()
        ? 'brave'
        : env.SEARXNG_URL?.trim()
          ? 'searxng'
          : 'disabled'
  )) as WebSearchProviderName
  if (provider === 'tavily' && !env.TAVILY_API_KEY?.trim()) {
    throw new Error('TAVILY_API_KEY is required when WEB_SEARCH_PROVIDER=tavily')
  }
  if (provider === 'brave' && !env.BRAVE_SEARCH_API_KEY?.trim()) {
    throw new Error('BRAVE_SEARCH_API_KEY is required when WEB_SEARCH_PROVIDER=brave')
  }
  if (provider === 'searxng' && !env.SEARXNG_URL?.trim()) {
    throw new Error('SEARXNG_URL is required when WEB_SEARCH_PROVIDER=searxng')
  }
  return provider
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

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
  const consumerAccessMode = (
    env.WRITE_CONSUMER_ACCESS_MODE?.trim() || 'cross-workspace'
  ) as WorkerConsumerAccessMode
  if (!['cross-workspace', 'single-workspace'].includes(consumerAccessMode)) {
    throw new Error('WRITE_CONSUMER_ACCESS_MODE must be cross-workspace or single-workspace')
  }
  const singleWorkspaceId = env.WORKER_SINGLE_USER_WORKSPACE_ID?.trim()
  const singlePrincipalId = env.WORKER_SINGLE_USER_PRINCIPAL_ID?.trim()
  if (
    consumer && consumerAccessMode === 'single-workspace' &&
    (!singleWorkspaceId || !UUID_PATTERN.test(singleWorkspaceId))
  ) {
    throw new Error('WORKER_SINGLE_USER_WORKSPACE_ID must be a UUID in single-workspace mode')
  }
  if (
    consumer && consumerAccessMode === 'single-workspace' &&
    (!singlePrincipalId || !UUID_PATTERN.test(singlePrincipalId))
  ) {
    throw new Error('WORKER_SINGLE_USER_PRINCIPAL_ID must be a UUID in single-workspace mode')
  }
  const leaseDurationMs = positiveInt(env, 'WORKER_LEASE_DURATION_MS', 60_000)
  const heartbeatIntervalMs = positiveInt(env, 'WORKER_HEARTBEAT_INTERVAL_MS', 15_000)
  const healthPort = optionalPort(env, 'WORKER_HEALTH_PORT')
  const anthropicThinkingMode = env.ANTHROPIC_THINKING_MODE?.trim()
  const selectedSearchProvider = consumer ? webSearchProvider(env) : 'disabled'
  const webExtractEnabled = consumer && booleanValue(env, 'WEB_EXTRACT_ENABLED', true)
  const webExtractTimeoutMs = positiveInt(env, 'WEB_EXTRACT_TIMEOUT_MS', 15_000)
  const webExtractMaxResponseBytes = positiveInt(env, 'WEB_EXTRACT_MAX_RESPONSE_BYTES', 1_000_000)
  const webExtractMaxTextChars = positiveInt(env, 'WEB_EXTRACT_MAX_TEXT_CHARS', 20_000)
  if (webExtractTimeoutMs > 60_000) throw new Error('WEB_EXTRACT_TIMEOUT_MS cannot exceed 60000')
  if (webExtractMaxResponseBytes > 5_000_000) throw new Error('WEB_EXTRACT_MAX_RESPONSE_BYTES cannot exceed 5000000')
  if (webExtractMaxTextChars > 100_000) throw new Error('WEB_EXTRACT_MAX_TEXT_CHARS cannot exceed 100000')
  if (anthropicThinkingMode && !['enabled', 'disabled'].includes(anthropicThinkingMode)) {
    throw new Error('ANTHROPIC_THINKING_MODE must be enabled or disabled')
  }
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
    consumerAccessMode,
    ...(singleWorkspaceId ? { singleWorkspaceId } : {}),
    ...(singlePrincipalId ? { singlePrincipalId } : {}),
    redis: redisConnection(required(env, 'REDIS_URL')),
    ...(consumer ? {
      anthropicApiKey: required(env, 'ANTHROPIC_API_KEY'),
      modelId: required(env, 'MODEL_ID'),
    } : {}),
    ...(env.ANTHROPIC_BASE_URL?.trim() ? { anthropicBaseUrl: env.ANTHROPIC_BASE_URL.trim() } : {}),
    ...(anthropicThinkingMode ? {
      anthropicThinkingMode: anthropicThinkingMode as 'enabled' | 'disabled',
    } : {}),
    ...(env.TAVILY_API_KEY?.trim() ? { tavilyApiKey: env.TAVILY_API_KEY.trim() } : {}),
    ...(env.TAVILY_BASE_URL?.trim() ? { tavilyBaseUrl: env.TAVILY_BASE_URL.trim() } : {}),
    ...(env.BRAVE_SEARCH_API_KEY?.trim()
      ? { braveSearchApiKey: env.BRAVE_SEARCH_API_KEY.trim() }
      : {}),
    ...(env.BRAVE_SEARCH_BASE_URL?.trim()
      ? { braveSearchBaseUrl: env.BRAVE_SEARCH_BASE_URL.trim() }
      : {}),
    ...(env.SEARXNG_URL?.trim() ? { searxngUrl: env.SEARXNG_URL.trim() } : {}),
    webSearchProvider: selectedSearchProvider,
    webExtractEnabled,
    webExtractTimeoutMs,
    webExtractMaxResponseBytes,
    webExtractMaxTextChars,
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
