import { describe, expect, it, vi } from 'vitest'
import { loadProductionWorkerConfig, webResearchToolVersions } from '../src/config'
import { WorkerProcessRuntime } from '../src/process-runtime'

const baseEnv = {
  DURABLE_WORKER_ENABLED: 'true',
  DATABASE_WRITE_DISPATCHER_URL: 'postgres://dispatcher@db/vibe',
  WRITE_DISPATCHER_DATABASE_ROLE: 'vibe_writer_write_dispatcher',
  DATABASE_WRITE_CONSUMER_URL: 'postgres://consumer@db/vibe',
  WRITE_CONSUMER_DATABASE_ROLE: 'vibe_writer_write_consumer',
  REDIS_URL: 'rediss://user:pass@redis.example:6380/2',
  ANTHROPIC_API_KEY: 'model-secret', MODEL_ID: 'model-1', CODE_REVISION: 'abc123', WORKER_ID: 'worker-1',
}

describe('production worker config', () => {
  it('fails closed and validates consumer secrets before opening resources', () => {
    expect(() => loadProductionWorkerConfig({ ...baseEnv, DURABLE_WORKER_ENABLED: undefined })).toThrow('DURABLE_WORKER_ENABLED')
    expect(() => loadProductionWorkerConfig({ ...baseEnv, ANTHROPIC_API_KEY: undefined })).toThrow('ANTHROPIC_API_KEY')
    expect(() => loadProductionWorkerConfig({
      ...baseEnv, ANTHROPIC_THINKING_MODE: 'sometimes',
    })).toThrow('ANTHROPIC_THINKING_MODE')
    expect(loadProductionWorkerConfig({
      ...baseEnv, ANTHROPIC_THINKING_MODE: 'disabled',
    }).anthropicThinkingMode).toBe('disabled')
  })

  it('selects one explicit web search provider and keeps extraction limits bounded', () => {
    expect(loadProductionWorkerConfig({
      ...baseEnv,
      TAVILY_API_KEY: 'search-secret',
    })).toMatchObject({
      webSearchProvider: 'tavily',
      webExtractEnabled: true,
      webExtractTimeoutMs: 15_000,
      webExtractMaxResponseBytes: 1_000_000,
      webExtractMaxTextChars: 20_000,
    })
    expect(loadProductionWorkerConfig({
      ...baseEnv,
      WEB_SEARCH_PROVIDER: 'searxng',
      SEARXNG_URL: 'http://search.internal:8080',
      WEB_EXTRACT_ENABLED: 'false',
    })).toMatchObject({
      webSearchProvider: 'searxng',
      searxngUrl: 'http://search.internal:8080',
      webExtractEnabled: false,
    })
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      WEB_SEARCH_PROVIDER: 'brave',
    })).toThrow('BRAVE_SEARCH_API_KEY')
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      WEB_EXTRACT_MAX_RESPONSE_BYTES: '5000001',
    })).toThrow('WEB_EXTRACT_MAX_RESPONSE_BYTES')
  })

  it('keeps search disabled when no provider is configured', () => {
    expect(loadProductionWorkerConfig(baseEnv)).toMatchObject({
      webSearchProvider: 'disabled',
      webExtractEnabled: true,
    })
  })

  it('projects provider selection and extraction budgets into the durable run snapshot', () => {
    const config = loadProductionWorkerConfig({
      ...baseEnv,
      WEB_SEARCH_PROVIDER: 'brave',
      BRAVE_SEARCH_API_KEY: 'search-secret',
      WEB_EXTRACT_TIMEOUT_MS: '12000',
      WEB_EXTRACT_MAX_RESPONSE_BYTES: '750000',
      WEB_EXTRACT_MAX_TEXT_CHARS: '18000',
    })

    expect(webResearchToolVersions(config)).toEqual({
      search: 'brave-search-v1',
      webExtract: 'readability-v1:timeout-12000:bytes-750000:chars-18000',
    })
  })

  it('supports an independently scaled dispatcher without model credentials', () => {
    const config = loadProductionWorkerConfig({
      ...baseEnv, DURABLE_WORKER_ROLE: 'dispatcher', ANTHROPIC_API_KEY: undefined, MODEL_ID: undefined,
    })
    expect(config).toMatchObject({
      role: 'dispatcher', workerId: 'worker-1',
      dispatcherDatabase: {
        url: 'postgres://dispatcher@db/vibe',
        role: 'vibe_writer_write_dispatcher',
      },
      redis: { host: 'redis.example', port: 6380, db: 2, username: 'user', password: 'pass', tls: {} },
    })
    expect(config.consumerDatabase).toBeUndefined()
    expect(config.anthropicApiKey).toBeUndefined()
  })

  it('requires independent dispatcher and consumer identities in all mode', () => {
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      DATABASE_WRITE_CONSUMER_URL: baseEnv.DATABASE_WRITE_DISPATCHER_URL,
    })).toThrow('URLs must be distinct')
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      WRITE_CONSUMER_DATABASE_ROLE: baseEnv.WRITE_DISPATCHER_DATABASE_ROLE,
    })).toThrow('roles must be distinct')
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      DATABASE_URL: 'postgres://owner@db/vibe',
      DATABASE_WRITE_CONSUMER_URL: undefined,
    })).toThrow('DATABASE_WRITE_CONSUMER_URL')
  })

  it('requires an explicit UUID for managed single-workspace consumers', () => {
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      WRITE_CONSUMER_ACCESS_MODE: 'single-workspace',
    })).toThrow('WORKER_SINGLE_USER_WORKSPACE_ID')
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      WRITE_CONSUMER_ACCESS_MODE: 'single-workspace',
      WORKER_SINGLE_USER_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222',
    })).toThrow('WORKER_SINGLE_USER_PRINCIPAL_ID')
    expect(loadProductionWorkerConfig({
      ...baseEnv,
      WRITE_CONSUMER_ACCESS_MODE: 'single-workspace',
      WORKER_SINGLE_USER_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222',
      WORKER_SINGLE_USER_PRINCIPAL_ID: '11111111-1111-4111-8111-111111111111',
    })).toMatchObject({
      consumerAccessMode: 'single-workspace',
      singleWorkspaceId: '22222222-2222-4222-8222-222222222222',
      singlePrincipalId: '11111111-1111-4111-8111-111111111111',
    })
  })

  it('enables a bounded health listener only when an explicit port is configured', () => {
    expect(loadProductionWorkerConfig({
      ...baseEnv,
      WORKER_HEALTH_HOST: '127.0.0.1',
      WORKER_HEALTH_PORT: '3101',
    }).health).toEqual({ host: '127.0.0.1', port: 3101 })
    expect(() => loadProductionWorkerConfig({
      ...baseEnv,
      WORKER_HEALTH_PORT: '70000',
    })).toThrow('WORKER_HEALTH_PORT')
  })
})

describe('worker process lifecycle', () => {
  it('starts dependencies in order and closes intake before durable resources', async () => {
    const calls: string[] = []
    const runtime = new WorkerProcessRuntime({
      startHealth: vi.fn(async () => { calls.push('health:start') }),
      checkDatabase: vi.fn(async () => { calls.push('database:check') }),
      startPublisher: vi.fn(async () => { calls.push('publisher:start') }),
      startConsumer: vi.fn(async () => { calls.push('consumer:start') }),
      dispatchBatch: vi.fn(async () => { calls.push('dispatch') }),
      closeConsumer: vi.fn(async () => { calls.push('consumer:close') }),
      closePublisher: vi.fn(async () => { calls.push('publisher:close') }),
      closeCheckpoint: vi.fn(async () => { calls.push('checkpoint:close') }),
      closeDatabase: vi.fn(async () => { calls.push('database:close') }),
      markReady: vi.fn(() => { calls.push('health:ready') }),
      markDraining: vi.fn(() => { calls.push('health:draining') }),
      closeHealth: vi.fn(async () => { calls.push('health:close') }),
      onDispatcherError: vi.fn(),
    }, 60_000)
    await runtime.start()
    await vi.waitFor(() => expect(calls).toContain('dispatch'))
    await runtime.close()
    expect(calls.slice(0, 5)).toEqual([
      'health:start', 'database:check',
      'publisher:start', 'consumer:start', 'health:ready',
    ])
    expect(calls.slice(-6)).toEqual([
      'health:draining', 'consumer:close', 'publisher:close',
      'checkpoint:close', 'database:close', 'health:close',
    ])
  })
})
