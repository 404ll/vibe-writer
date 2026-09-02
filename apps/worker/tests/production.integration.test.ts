import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROMPT_SET_VERSION, TOOLSET_VERSIONS } from '@vibe-writer/agent-core'
import {
  ProductionCompositionFixtureSchema,
  ProductionCompositionObservationSchema,
  type ProductionCompositionObservation,
} from '@vibe-writer/contracts/production-composition-fixtures'
import {
  ProductionCancellationFixtureSchema,
  ProductionCancellationObservationSchema,
  type ProductionCancellationObservation,
} from '@vibe-writer/contracts/production-cancellation-fixtures'
import {
  ProductionFailureFixtureSchema,
  ProductionFailureObservationSchema,
  type ProductionFailureObservation,
} from '@vibe-writer/contracts/production-failure-fixtures'
import {
  ProductionTakeoverFixtureSchema,
  ProductionTakeoverObservationSchema,
  type ProductionTakeoverObservation,
} from '@vibe-writer/contracts/production-takeover-fixtures'
import { WorkflowShadowFixtureSchema } from '@vibe-writer/contracts/workflow-shadow-fixtures'
import {
  compareEvalBaseline,
  fingerprintEvalValue,
  parseEvalBaseline,
  runOfflineEval,
  type EvalCase,
} from '@vibe-writer/eval-core'
import {
  assertCurrentWriteRuntimeRole,
  createJobRepository,
  createCommandRepository,
  createPostgresDatabase,
  createTerminalRepository,
  fingerprintEffectRequest,
  SYSTEM_PRINCIPAL_ID,
  SYSTEM_WORKSPACE_ID,
  provisionWriteRuntimeRole,
} from '@vibe-writer/db'
import * as schema from '@vibe-writer/db/schema'
import { createPostgresSaver } from '@vibe-writer/checkpoint-runtime'
import { WRITER_REVIEWER_WORKFLOW_VERSION } from '@vibe-writer/workflow-runtime'
import { asc, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createProductionWorkerRuntime,
  loadProductionWorkerConfig,
} from '../src'

const databaseUrl = process.env.TEST_DATABASE_URL
const redisUrl = process.env.TEST_REDIS_URL
const workerHealthPort = Number(process.env.TEST_WORKER_HEALTH_PORT)
const testId = process.env.VIBE_WRITER_PRODUCTION_TEST_ID
if (
  !databaseUrl || !redisUrl || !testId || !/^[0-9a-f]{32}$/.test(testId) ||
  !Number.isInteger(workerHealthPort) || workerHealthPort < 1 || workerHealthPort > 65_535
) {
  throw new Error('Harness-created production integration targets are required')
}
for (const target of [databaseUrl, redisUrl]) {
  const url = new URL(target)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error(`Refusing non-loopback integration target ${url.host}`)
  }
}
if (!new URL(databaseUrl).pathname.endsWith(testId)) {
  throw new Error('Refusing PostgreSQL database without the harness test id')
}
const integrationDatabaseUrl = databaseUrl
const integrationRedisUrl = redisUrl
const integrationTestId = testId
const dispatcherDatabaseRole = `write_dispatcher_${testId}`
const consumerDatabaseRole = `write_consumer_${testId}`

function databaseUrlForRole(role: string): string {
  const url = new URL(integrationDatabaseUrl)
  url.username = role
  url.password = ''
  return url.toString()
}

const dispatcherDatabaseUrl = databaseUrlForRole(dispatcherDatabaseRole)
const consumerDatabaseUrl = databaseUrlForRole(consumerDatabaseRole)

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
)
const productionFixture = ProductionCompositionFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/production-composition-baseline.json', import.meta.url),
  'utf8',
)))
const cancellationFixture = ProductionCancellationFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/production-cancellation-baseline.json', import.meta.url),
  'utf8',
)))
const failureFixture = ProductionFailureFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/production-failure-baseline.json', import.meta.url),
  'utf8',
)))
const takeoverFixture = ProductionTakeoverFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/production-takeover-baseline.json', import.meta.url),
  'utf8',
)))
const workflowFixture = WorkflowShadowFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/workflow-shadow-baseline.json', import.meta.url),
  'utf8',
)))
const productionBaseline = parseEvalBaseline(JSON.parse(readFileSync(
  new URL('../../eval/baselines/production-composition-v3.json', import.meta.url),
  'utf8',
)))
const cancellationBaseline = parseEvalBaseline(JSON.parse(readFileSync(
  new URL('../../eval/baselines/production-cancellation-v2.json', import.meta.url),
  'utf8',
)))
const failureBaseline = parseEvalBaseline(JSON.parse(readFileSync(
  new URL('../../eval/baselines/production-failure-v2.json', import.meta.url),
  'utf8',
)))
const takeoverBaseline = parseEvalBaseline(JSON.parse(readFileSync(
  new URL('../../eval/baselines/production-takeover-v2.json', import.meta.url),
  'utf8',
)))
const closers: Array<() => Promise<unknown>> = []

async function ensureRole(
  database: ReturnType<typeof createPostgresDatabase>,
  roleName: string,
) {
  const [existing] = await database.client<{ exists: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = ${roleName}) as exists
  `
  if (!existing?.exists) await database.client.unsafe(`CREATE ROLE "${roleName}"`)
}

async function prepareWriteRuntime(
  database: ReturnType<typeof createPostgresDatabase>,
) {
  await migrate(database.db, { migrationsFolder })
  const saver = createPostgresSaver(integrationDatabaseUrl)
  try {
    await saver.setup()
  } finally {
    await saver.end()
  }
  await ensureRole(database, dispatcherDatabaseRole)
  await ensureRole(database, consumerDatabaseRole)
  await provisionWriteRuntimeRole(
    database.client,
    'dispatcher',
    dispatcherDatabaseRole,
  )
  await provisionWriteRuntimeRole(
    database.client,
    'consumer',
    consumerDatabaseRole,
  )
}

function writeRuntimeDatabaseEnvironment() {
  return {
    DATABASE_WRITE_DISPATCHER_URL: dispatcherDatabaseUrl,
    WRITE_DISPATCHER_DATABASE_ROLE: dispatcherDatabaseRole,
    DATABASE_WRITE_CONSUMER_URL: consumerDatabaseUrl,
    WRITE_CONSUMER_DATABASE_ROLE: consumerDatabaseRole,
  }
}

class TerminalIntegrationError extends Error {}

type ProductionCompositionInput = {
  id: string
  workflowCaseId: string
  topic: string
  initialOutline: string[]
  expectedOutline: string[]
  replies: Array<{ message: string; outline: string[] | null }>
  interventionOnOutline: boolean
  fullReviewRounds: Array<Array<'passed' | 'failed'>>
  targetWords: number
}

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).reverse().map((close) => close()))
})

function canonicalMarkdown(value: string): string {
  return value.trim().replace(/\n{3,}/g, '\n\n')
}

async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      if (error instanceof TerminalIntegrationError) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

async function fakeAnthropicServer(input: ProductionCompositionInput) {
  let requestSequence = 0
  let writerSequence = 0
  let fullReviewSequence = 0
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    requests.push(body)
    requestSequence += 1

    const system = typeof body.system === 'string' ? body.system : ''
    const tools = Array.isArray(body.tools) ? body.tools : []
    let text: string
    if (system.includes('独立 Reviewer Agent')) {
      const verdicts = input.fullReviewRounds[fullReviewSequence]
      if (!verdicts) throw new Error('Missing scripted Reviewer round')
      fullReviewSequence += 1
      const approved = verdicts.every((verdict) => verdict === 'passed')
      text = JSON.stringify(approved
        ? {
            version: 'review-report-v1',
            verdict: 'approved',
            summary: '全文可交付。',
            globalIssues: [],
            localIssues: [],
          }
        : {
            version: 'review-report-v1',
            verdict: 'needs_revision',
            summary: '需要补充论证。',
            globalIssues: ['补充关键论证。'],
            localIssues: [],
          })
    } else if (tools.length > 0) {
      writerSequence += 1
      text = [
        `# ${input.topic}`,
        ...input.expectedOutline.flatMap((title) => [
          '',
          `## ${title}`,
          `${title}正文-v${writerSequence}`,
        ]),
      ].join('\n')
    } else if (system.includes('技术内容策划')) {
      text = JSON.stringify({
        opinions: [`覆盖 ${input.initialOutline[0]}`],
        search_queries: [`${input.initialOutline[0]} 查询`],
      })
    } else if (system.includes('审阅给定章节')) {
      text = JSON.stringify({ passed: true, feedback: '' })
    } else {
      text = input.initialOutline
        .map((title, index) => `${index + 1}. ${title}`)
        .join('\n')
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      id: `fake-message-${requestSequence}`,
      model: 'fake-anthropic-v1',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake provider has no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function fakeBlockingAnthropicServer() {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    // Deliberately keep the provider call open. The Worker must abort it after the
    // database cancellation is observed by heartbeat; the test server never wins.
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake provider has no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function fakeFailingAnthropicServer(status: 503) {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake provider has no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function sourceRevision(): string {
  const hash = createHash('sha256')
  const sourceRoot = join(repositoryRoot, 'apps', 'worker', 'src')
  const files = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === '.ts')
    .map((entry) => join(sourceRoot, entry.name))
    .sort()
  for (const file of [
    ...files,
    fileURLToPath(import.meta.url),
    join(repositoryRoot, 'packages', 'contracts', 'fixtures', 'production-composition-baseline.json'),
    join(repositoryRoot, 'packages', 'contracts', 'fixtures', 'production-cancellation-baseline.json'),
    join(repositoryRoot, 'packages', 'contracts', 'fixtures', 'production-failure-baseline.json'),
    join(repositoryRoot, 'packages', 'contracts', 'fixtures', 'production-takeover-baseline.json'),
  ]) {
    hash.update(relative(repositoryRoot, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return `production-composition-source@sha256:${hash.digest('hex')}`
}

async function executeProductionCancellation(input: {
  id: string
  topic: string
  targetWords: number
}): Promise<ProductionCancellationObservation> {
  const provider = await fakeBlockingAnthropicServer()
  closers.push(provider.close)
  const database = createPostgresDatabase(integrationDatabaseUrl, { max: 5 })
  closers.push(database.close)
  await prepareWriteRuntime(database)
  const jobs = createJobRepository(database.db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: `production-cancellation-${input.id}-${integrationTestId}`,
    topic: input.topic,
    target_words: input.targetWords,
    intervention: { on_outline: false },
  })
  const runtime = createProductionWorkerRuntime(loadProductionWorkerConfig({
    DURABLE_WORKER_ENABLED: 'true',
    DURABLE_WORKER_ROLE: 'all',
    ...writeRuntimeDatabaseEnvironment(),
    REDIS_URL: integrationRedisUrl,
    ANTHROPIC_API_KEY: 'fake-integration-key',
    ANTHROPIC_BASE_URL: provider.baseUrl,
    MODEL_ID: 'fake-anthropic-v1',
    CODE_REVISION: sourceRevision(),
    WORKER_ID: `production-cancel-worker-${integrationTestId}`,
    WRITE_QUEUE_NAME: `production-cancel-${integrationTestId}`,
    BULLMQ_PREFIX: `vibe-writer-production-cancel-${integrationTestId}`,
    WORKER_CONCURRENCY: '1',
    WORKER_LEASE_DURATION_MS: '2000',
    WORKER_HEARTBEAT_INTERVAL_MS: '100',
    BULLMQ_LOCK_DURATION_MS: '5000',
    OUTBOX_POLL_MS: '25',
    OUTBOX_BATCH_SIZE: '10',
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: String(workerHealthPort),
  }))
  closers.push(runtime.close.bind(runtime))
  await runtime.start()

  await eventually(async () => {
    expect(provider.requests).toHaveLength(1)
    expect(await jobs.getJob(job.id)).toMatchObject({ status: 'running' })
  })
  const cancellationResult = await jobs.requestCancellation(job.id)
  expect(cancellationResult).toBe('cancel_requested')
  await eventually(async () => {
    const current = await jobs.getJob(job.id)
    if (current?.status === 'failed') {
      throw new TerminalIntegrationError(
        `Cancellation job failed: ${current.errorCode}: ${current.errorMessage}`,
      )
    }
    expect(current).toMatchObject({ status: 'cancelled' })
  })
  await runtime.close()

  const [finalJob, runs, articles, events, outboxes, effects, spans] = await Promise.all([
    jobs.getJob(job.id),
    database.db.select().from(schema.runs)
      .where(eq(schema.runs.jobId, job.id)).orderBy(asc(schema.runs.attempt)),
    database.db.select().from(schema.articles).where(eq(schema.articles.jobId, job.id)),
    database.db.select().from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, job.id)).orderBy(asc(schema.jobEvents.seq)),
    database.db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, job.id)).orderBy(asc(schema.outboxEvents.createdAt)),
    database.db.select().from(schema.runEffects)
      .where(eq(schema.runEffects.jobId, job.id)).orderBy(asc(schema.runEffects.effectKey)),
    database.db.select().from(schema.traceSpans)
      .where(eq(schema.traceSpans.jobId, job.id)).orderBy(asc(schema.traceSpans.spanKey)),
  ])
  expect(JSON.stringify(effects)).not.toContain(input.topic)
  expect(JSON.stringify(spans)).not.toContain(input.topic)
  const observation = {
    jobStatus: finalJob?.status,
    runStatuses: runs.map((run) => run.status),
    articleCount: articles.length,
    eventTypes: events.map((event) => event.eventType),
    outboxStatuses: outboxes.map((outbox) => outbox.status),
    effectStatuses: effects.map((effect) => effect.status),
    traceStatuses: spans.map((span) => span.status),
    providerRequestCount: provider.requests.length,
    cancellationResult,
  }
  return ProductionCancellationObservationSchema.parse(observation)
}

async function executeProductionFailure(input: {
  id: string
  topic: string
  targetWords: number
  providerStatus: 503
}): Promise<ProductionFailureObservation> {
  const provider = await fakeFailingAnthropicServer(input.providerStatus)
  closers.push(provider.close)
  const database = createPostgresDatabase(integrationDatabaseUrl, { max: 5 })
  closers.push(database.close)
  await prepareWriteRuntime(database)
  const jobs = createJobRepository(database.db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: `production-failure-${input.id}-${integrationTestId}`,
    topic: input.topic,
    target_words: input.targetWords,
    intervention: { on_outline: false },
  })
  const runtime = createProductionWorkerRuntime(loadProductionWorkerConfig({
    DURABLE_WORKER_ENABLED: 'true',
    DURABLE_WORKER_ROLE: 'all',
    ...writeRuntimeDatabaseEnvironment(),
    REDIS_URL: integrationRedisUrl,
    ANTHROPIC_API_KEY: 'fake-integration-key',
    ANTHROPIC_BASE_URL: provider.baseUrl,
    MODEL_ID: 'fake-anthropic-v1',
    CODE_REVISION: sourceRevision(),
    WORKER_ID: `production-failure-worker-${integrationTestId}`,
    WRITE_QUEUE_NAME: `production-failure-${integrationTestId}`,
    BULLMQ_PREFIX: `vibe-writer-production-failure-${integrationTestId}`,
    WORKER_CONCURRENCY: '1',
    WORKER_LEASE_DURATION_MS: '2000',
    WORKER_HEARTBEAT_INTERVAL_MS: '100',
    BULLMQ_LOCK_DURATION_MS: '5000',
    OUTBOX_POLL_MS: '25',
    OUTBOX_BATCH_SIZE: '10',
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: String(workerHealthPort),
  }))
  closers.push(runtime.close.bind(runtime))
  await runtime.start()

  await eventually(async () => {
    const current = await jobs.getJob(job.id)
    if (current?.status === 'cancelled') {
      throw new TerminalIntegrationError('Provider failure unexpectedly cancelled the job')
    }
    expect(current).toMatchObject({ status: 'failed' })
  })
  await runtime.close()

  const [finalJob, runs, articles, events, outboxes, effects, spans] = await Promise.all([
    jobs.getJob(job.id),
    database.db.select().from(schema.runs)
      .where(eq(schema.runs.jobId, job.id)).orderBy(asc(schema.runs.attempt)),
    database.db.select().from(schema.articles).where(eq(schema.articles.jobId, job.id)),
    database.db.select().from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, job.id)).orderBy(asc(schema.jobEvents.seq)),
    database.db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, job.id)).orderBy(asc(schema.outboxEvents.createdAt)),
    database.db.select().from(schema.runEffects)
      .where(eq(schema.runEffects.jobId, job.id)).orderBy(asc(schema.runEffects.effectKey)),
    database.db.select().from(schema.traceSpans)
      .where(eq(schema.traceSpans.jobId, job.id)).orderBy(asc(schema.traceSpans.spanKey)),
  ])
  expect(JSON.stringify(effects)).not.toContain(input.topic)
  expect(JSON.stringify(spans)).not.toContain(input.topic)
  const observation = {
    jobStatus: finalJob?.status,
    jobErrorCode: finalJob?.errorCode,
    runStatuses: runs.map((run) => run.status),
    runErrorCodes: runs.map((run) => run.errorCode),
    articleCount: articles.length,
    eventTypes: events.map((event) => event.eventType),
    outboxStatuses: outboxes.map((outbox) => outbox.status),
    effectStatuses: effects.map((effect) => effect.status),
    effectErrorCodes: effects.map((effect) => effect.errorCode),
    traceStatuses: spans.map((span) => span.status),
    traceErrorCodes: spans.map((span) => span.errorCode),
    providerRequestCount: provider.requests.length,
  }
  return ProductionFailureObservationSchema.parse(observation)
}

async function executeProductionTakeover(
  input: ProductionCompositionInput,
): Promise<ProductionTakeoverObservation> {
  const provider = await fakeAnthropicServer(input)
  closers.push(provider.close)
  const database = createPostgresDatabase(integrationDatabaseUrl, { max: 5 })
  closers.push(database.close)
  await prepareWriteRuntime(database)
  const jobs = createJobRepository(database.db)
  const terminals = createTerminalRepository(database.db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: `production-takeover-${input.id}-${integrationTestId}`,
    topic: input.topic,
    target_words: input.targetWords,
    intervention: { on_outline: false },
  })
  const staleClaim = await jobs.claimJob({
    jobId: job.id,
    workerId: `stale-worker-${integrationTestId}`,
    leaseDurationMs: 30_000,
    execution: {
      modelProfile: {
        profile: 'loopback:stale-anthropic-v1',
        provider: 'anthropic',
        model: 'fake-anthropic-v1',
      },
      promptVersion: PROMPT_SET_VERSION,
      graphVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
      toolVersions: { writerAgent: TOOLSET_VERSIONS.writerAgent },
      codeRevision: sourceRevision(),
    },
  })
  if (!staleClaim) throw new Error('Expected the stale Worker claim')
  const staleIdentity = {
    jobId: job.id,
    runId: staleClaim.run.id,
    leaseToken: staleClaim.leaseToken,
  }
  await expect(jobs.reserveRunEffect({
    ...staleIdentity,
    effectKey: 'model:plan:attempt:1',
    effectType: 'model_call',
    requestFingerprint: fingerprintEffectRequest({ staleAttempt: 1 }),
    trace: { operation: 'planner.plan' },
  })).resolves.toMatchObject({ status: 'reserved' })
  await database.db.update(schema.jobs)
    .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
    .where(eq(schema.jobs.id, job.id))

  const runtime = createProductionWorkerRuntime(loadProductionWorkerConfig({
    DURABLE_WORKER_ENABLED: 'true',
    DURABLE_WORKER_ROLE: 'all',
    ...writeRuntimeDatabaseEnvironment(),
    REDIS_URL: integrationRedisUrl,
    ANTHROPIC_API_KEY: 'fake-integration-key',
    ANTHROPIC_BASE_URL: provider.baseUrl,
    MODEL_ID: 'fake-anthropic-v1',
    CODE_REVISION: sourceRevision(),
    WORKER_ID: `production-takeover-worker-${integrationTestId}`,
    WRITE_QUEUE_NAME: `production-takeover-${integrationTestId}`,
    BULLMQ_PREFIX: `vibe-writer-production-takeover-${integrationTestId}`,
    WORKER_CONCURRENCY: '1',
    WORKER_LEASE_DURATION_MS: '2000',
    WORKER_HEARTBEAT_INTERVAL_MS: '100',
    BULLMQ_LOCK_DURATION_MS: '5000',
    OUTBOX_POLL_MS: '25',
    OUTBOX_BATCH_SIZE: '10',
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: String(workerHealthPort),
  }))
  closers.push(runtime.close.bind(runtime))
  await runtime.start()
  await eventually(async () => {
    const current = await jobs.getJob(job.id)
    if (current?.status === 'failed' || current?.status === 'cancelled') {
      throw new TerminalIntegrationError(
        `Takeover job terminated ${current.status}: ${current.errorCode}: ${current.errorMessage}`,
      )
    }
    expect(current).toMatchObject({ status: 'completed' })
  })
  await runtime.close()

  const staleEffectFinish = await jobs.finishRunEffect({
    ...staleIdentity,
    effectKey: 'model:plan:attempt:1',
    outcome: 'failed',
    errorCode: 'stale_worker_write',
    errorMessage: 'A stale Worker must not finish an effect.',
  })
  const staleTerminal = await terminals.terminateClaim({
    ...staleIdentity,
    outcome: 'failed',
    errorCode: 'stale_worker_write',
    errorMessage: 'A stale Worker must not terminate the job.',
  })
  const [finalJob, runs, articles, events, outboxes, effects, spans] = await Promise.all([
    jobs.getJob(job.id),
    database.db.select().from(schema.runs)
      .where(eq(schema.runs.jobId, job.id)).orderBy(asc(schema.runs.attempt)),
    database.db.select().from(schema.articles).where(eq(schema.articles.jobId, job.id)),
    database.db.select().from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, job.id)).orderBy(asc(schema.jobEvents.seq)),
    database.db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, job.id)).orderBy(asc(schema.outboxEvents.createdAt)),
    database.db.select().from(schema.runEffects)
      .where(eq(schema.runEffects.jobId, job.id)).orderBy(asc(schema.runEffects.effectKey)),
    database.db.select().from(schema.traceSpans)
      .where(eq(schema.traceSpans.jobId, job.id)).orderBy(asc(schema.traceSpans.spanKey)),
  ])
  expect(JSON.stringify(effects)).not.toContain(input.topic)
  expect(JSON.stringify(spans)).not.toContain(input.topic)
  const effectStatusCounts = {
    succeeded: effects.filter((effect) => effect.status === 'succeeded').length,
    uncertain: effects.filter((effect) => effect.status === 'uncertain').length,
  }
  const traceStatusCounts = {
    succeeded: spans.filter((span) => span.status === 'succeeded').length,
    uncertain: spans.filter((span) => span.status === 'uncertain').length,
  }
  const observation = {
    jobStatus: finalJob?.status,
    runStatuses: runs.map((run) => run.status),
    runErrorCodes: runs.map((run) => run.errorCode),
    articleCount: articles.length,
    articleRevision: articles[0]?.revision,
    canonicalMarkdown: canonicalMarkdown(articles[0]?.content ?? ''),
    eventTypes: events.map((event) => event.eventType),
    outboxStatuses: outboxes.map((outbox) => outbox.status),
    effectStatusCounts,
    effectErrorCodes: effects.flatMap((effect) => effect.errorCode ? [effect.errorCode] : []),
    traceStatusCounts,
    traceErrorCodes: spans.flatMap((span) => span.errorCode ? [span.errorCode] : []),
    traceIdCount: new Set(spans.map((span) => span.traceId)).size,
    providerRequestCount: provider.requests.length,
    staleEffectFinishResult: staleEffectFinish.status,
    staleTerminalResult: staleTerminal.status,
  }
  return ProductionTakeoverObservationSchema.parse(observation)
}

async function executeProductionComposition(
  input: ProductionCompositionInput,
): Promise<ProductionCompositionObservation> {
  const provider = await fakeAnthropicServer(input)
  closers.push(provider.close)
  const database = createPostgresDatabase(integrationDatabaseUrl, { max: 5 })
  closers.push(database.close)
  await prepareWriteRuntime(database)
  const [databaseMetadata] = await database.client<{ comment: string }[]>`
    select shobj_description(oid, 'pg_database') as comment
    from pg_database
    where datname = current_database()
  `
  expect(databaseMetadata?.comment).toBe(`vibe-writer-production:${integrationTestId}`)

  const jobs = createJobRepository(database.db)
  const commands = createCommandRepository(database.db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: `production-composition-${input.id}-${integrationTestId}`,
    topic: input.topic,
    target_words: input.targetWords,
    intervention: { on_outline: input.interventionOnOutline },
  })
  const runtime = createProductionWorkerRuntime(loadProductionWorkerConfig({
    DURABLE_WORKER_ENABLED: 'true',
    DURABLE_WORKER_ROLE: 'all',
    ...writeRuntimeDatabaseEnvironment(),
    REDIS_URL: integrationRedisUrl,
    ANTHROPIC_API_KEY: 'fake-integration-key',
    ANTHROPIC_BASE_URL: provider.baseUrl,
    MODEL_ID: 'fake-anthropic-v1',
    CODE_REVISION: sourceRevision(),
    WORKER_ID: `production-worker-${integrationTestId}`,
    WRITE_QUEUE_NAME: `production-write-${integrationTestId}`,
    BULLMQ_PREFIX: `vibe-writer-production-${integrationTestId}`,
    WORKER_CONCURRENCY: '1',
    WORKER_LEASE_DURATION_MS: '10000',
    WORKER_HEARTBEAT_INTERVAL_MS: '1000',
    BULLMQ_LOCK_DURATION_MS: '10000',
    OUTBOX_POLL_MS: '25',
    OUTBOX_BATCH_SIZE: '10',
    WORKER_HEALTH_HOST: '127.0.0.1',
    WORKER_HEALTH_PORT: String(workerHealthPort),
  }))
  closers.push(runtime.close.bind(runtime))
  await runtime.start()

  const healthOrigin = `http://127.0.0.1:${workerHealthPort}`
  const liveResponse = await fetch(`${healthOrigin}/live`)
  expect(liveResponse.status).toBe(200)
  await expect(liveResponse.json()).resolves.toEqual({ status: 'live' })
  const readyResponse = await fetch(`${healthOrigin}/ready`)
  expect(readyResponse.status).toBe(200)
  await expect(readyResponse.json()).resolves.toEqual({ status: 'ready' })

  for (const reply of input.replies) {
    await eventually(async () => {
      expect(await jobs.getJob(job.id)).toMatchObject({ status: 'awaiting_input' })
    })
    await expect(commands.submitOutlineReply({ jobId: job.id, reply }))
      .resolves.toMatchObject({ status: 'queued' })
  }

  await eventually(async () => {
    const current = await jobs.getJob(job.id)
    if (current?.status === 'failed') {
      throw new TerminalIntegrationError(
        `Production job failed: ${current.errorCode}: ${current.errorMessage}`,
      )
    }
    expect(current).toMatchObject({ status: 'completed' })
  })
  await runtime.close()
  await runtime.close()
  await expect(fetch(`${healthOrigin}/ready`)).rejects.toThrow()

  const finalJob = await jobs.getJob(job.id)
  const articles = await database.db
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.jobId, job.id))
  const runs = await database.db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.jobId, job.id))
    .orderBy(asc(schema.runs.attempt))
  const events = await database.db
    .select()
    .from(schema.jobEvents)
    .where(eq(schema.jobEvents.jobId, job.id))
    .orderBy(asc(schema.jobEvents.seq))
  const outboxes = await database.db
    .select()
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.aggregateId, job.id))
    .orderBy(asc(schema.outboxEvents.createdAt))
  const effects = await database.db
    .select()
    .from(schema.runEffects)
    .where(eq(schema.runEffects.jobId, job.id))
    .orderBy(asc(schema.runEffects.effectKey))
  const spans = await database.db
    .select()
    .from(schema.traceSpans)
    .where(eq(schema.traceSpans.jobId, job.id))
    .orderBy(asc(schema.traceSpans.spanKey))

  expect(articles).toHaveLength(1)
  expect(effects.every((effect) => effect.status === 'succeeded')).toBe(true)
  expect(spans.every((span) => span.status === 'succeeded')).toBe(true)
  expect(spans.every((span) => span.inputTokens === 10 && span.outputTokens === 5)).toBe(true)
  expect(JSON.stringify(effects)).not.toContain('正文-v')
  expect(JSON.stringify(spans)).not.toContain('正文-v')

  const observation = {
    jobStatus: finalJob?.status,
    runStatuses: runs.map((run) => run.status),
    articleCount: articles.length,
    articleRevision: articles[0]?.revision,
    canonicalMarkdown: canonicalMarkdown(articles[0]?.content ?? ''),
    eventTypes: events.map((event) => event.eventType),
    outboxStatuses: outboxes.map((outbox) => outbox.status),
    effectKeys: effects.map((effect) => effect.effectKey),
    traceOperations: spans.map((span) => span.operation).sort(),
    traceIdCount: new Set(spans.map((span) => span.traceId)).size,
    providerRequestCount: provider.requests.length,
  }
  return ProductionCompositionObservationSchema.parse(observation)
}

describe.sequential('production worker composition', () => {
  it('enforces separate non-owner dispatcher, consumer, and checkpoint DDL boundaries', async () => {
    const owner = createPostgresDatabase(integrationDatabaseUrl, { max: 3 })
    const dispatcher = createPostgresDatabase(dispatcherDatabaseUrl, { max: 1 })
    const consumer = createPostgresDatabase(consumerDatabaseUrl, { max: 1 })
    try {
      await prepareWriteRuntime(owner)
      await expect(assertCurrentWriteRuntimeRole(
        dispatcher.client,
        'dispatcher',
        dispatcherDatabaseRole,
      )).resolves.toMatchObject({ issues: [] })
      await expect(assertCurrentWriteRuntimeRole(
        consumer.client,
        'consumer',
        consumerDatabaseRole,
      )).resolves.toMatchObject({ issues: [] })
      await expect(dispatcher.client`select id from public.jobs limit 1`).rejects.toThrow()
      await expect(consumer.client`select id from public.outbox_events limit 1`).rejects.toThrow()
      await expect(dispatcher.client.unsafe(
        `create schema dispatcher_forbidden_${integrationTestId}`,
      )).rejects.toThrow()
      await expect(consumer.client.unsafe(
        `create schema consumer_forbidden_${integrationTestId}`,
      )).rejects.toThrow()

      const consumerSaver = createPostgresSaver(consumerDatabaseUrl)
      try {
        await expect(consumerSaver.setup()).rejects.toThrow()
      } finally {
        await consumerSaver.end()
      }
    } finally {
      await Promise.all([owner.close(), dispatcher.close(), consumer.close()])
    }
  }, 20_000)

  it('projects a versioned workflow expected through Postgres, Redis, Worker and terminal state', async () => {
    const evalCases: Array<EvalCase<ProductionCompositionInput, ProductionCompositionObservation>> =
      productionFixture.cases.map((productionCase) => {
        const workflowCase = workflowFixture.cases.find(
          (scenario) => scenario.id === productionCase.workflow_case_id,
        )
        if (!workflowCase) throw new Error(`Missing workflow case ${productionCase.workflow_case_id}`)
        return {
          key: `${productionFixture.dataset_id}/${productionCase.id}`,
          input: {
            id: productionCase.id,
            workflowCaseId: workflowCase.id,
            topic: workflowCase.topic,
            initialOutline: workflowCase.initial_outline,
            expectedOutline: workflowCase.expected.outline,
            replies: workflowCase.replies,
            interventionOnOutline: workflowCase.intervention_on_outline,
            fullReviewRounds: workflowCase.full_review_rounds,
            targetWords: productionCase.target_words,
          },
          expected: productionCase.expected,
          tags: [productionFixture.dataset_id, workflowFixture.dataset_id, 'durable'],
        }
      })

    let targetFailure: unknown
    const report = await runOfflineEval(
      evalCases,
      {
        key: 'typescript-durable-production-composition',
        version: 'v3',
        async execute(input) {
          try {
            return await executeProductionComposition(input)
          } catch (error) {
            targetFailure = error
            throw error
          }
        },
      },
      [{
        key: 'canonical-production-projection',
        version: 'v1',
        metric: 'durable_projection_exact_match',
        evaluate: ({ output, case: evalCase }) => ({
          passed: fingerprintEvalValue(output) === fingerprintEvalValue(evalCase.expected),
        }),
      }],
      {
        suite: { key: 'production-composition-regression', version: '2026-09-03-v3' },
        execution: {
          modelProfile: 'loopback:anthropic-wire-v1',
          promptVersion: PROMPT_SET_VERSION,
          graphVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
          toolVersions: { writerAgent: TOOLSET_VERSIONS.writerAgent },
          codeRevision: sourceRevision(),
        },
      },
    )
    if (targetFailure) throw targetFailure
    expect(report.status).toBe('completed')
    expect(report.trials).toHaveLength(productionFixture.cases.length)
    expect(report.trials.every((trial) => trial.scores[0]?.passed === true)).toBe(true)
    const comparison = compareEvalBaseline(report, productionBaseline)
    expect(comparison).toMatchObject({ passed: true, failures: [] })
  }, 30_000)

  it('aborts an in-flight provider call and projects a durable cancelled terminal', async () => {
    const evalCases: Array<EvalCase<
      { id: string; topic: string; targetWords: number },
      ProductionCancellationObservation
    >> = cancellationFixture.cases.map((cancellationCase) => ({
      key: `${cancellationFixture.dataset_id}/${cancellationCase.id}`,
      input: {
        id: cancellationCase.id,
        topic: cancellationCase.topic,
        targetWords: cancellationCase.target_words,
      },
      expected: cancellationCase.expected,
      tags: [cancellationFixture.dataset_id, 'durable', 'cancellation'],
    }))
    let targetFailure: unknown
    const report = await runOfflineEval(
      evalCases,
      {
        key: 'typescript-durable-production-cancellation',
        version: 'v2',
        async execute(input) {
          try {
            return await executeProductionCancellation(input)
          } catch (error) {
            targetFailure = error
            throw error
          }
        },
      },
      [{
        key: 'canonical-production-cancellation',
        version: 'v1',
        metric: 'durable_cancellation_exact_match',
        evaluate: ({ output, case: evalCase }) => ({
          passed: fingerprintEvalValue(output) === fingerprintEvalValue(evalCase.expected),
        }),
      }],
      {
        suite: { key: 'production-cancellation-regression', version: '2026-09-03-v2' },
        execution: {
          modelProfile: 'loopback:blocked-anthropic-wire-v1',
          promptVersion: PROMPT_SET_VERSION,
          graphVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
          toolVersions: { writerAgent: TOOLSET_VERSIONS.writerAgent },
          codeRevision: sourceRevision(),
        },
      },
    )
    if (targetFailure) throw targetFailure
    expect(report.status).toBe('completed')
    expect(report.trials).toHaveLength(1)
    expect(report.trials[0]?.scores[0]?.passed).toBe(true)
    expect(compareEvalBaseline(report, cancellationBaseline))
      .toMatchObject({ passed: true, failures: [] })
  }, 30_000)

  it('projects a provider 5xx through failed effect, trace and durable terminal', async () => {
    const evalCases: Array<EvalCase<
      { id: string; topic: string; targetWords: number; providerStatus: 503 },
      ProductionFailureObservation
    >> = failureFixture.cases.map((failureCase) => ({
      key: `${failureFixture.dataset_id}/${failureCase.id}`,
      input: {
        id: failureCase.id,
        topic: failureCase.topic,
        targetWords: failureCase.target_words,
        providerStatus: failureCase.provider_status,
      },
      expected: failureCase.expected,
      tags: [failureFixture.dataset_id, 'durable', 'failure'],
    }))
    let targetFailure: unknown
    const report = await runOfflineEval(
      evalCases,
      {
        key: 'typescript-durable-production-failure',
        version: 'v2',
        async execute(input) {
          try {
            return await executeProductionFailure(input)
          } catch (error) {
            targetFailure = error
            throw error
          }
        },
      },
      [{
        key: 'canonical-production-failure',
        version: 'v1',
        metric: 'durable_failure_exact_match',
        evaluate: ({ output, case: evalCase }) => ({
          passed: fingerprintEvalValue(output) === fingerprintEvalValue(evalCase.expected),
        }),
      }],
      {
        suite: { key: 'production-failure-regression', version: '2026-09-03-v2' },
        execution: {
          modelProfile: 'loopback:anthropic-503-v1',
          promptVersion: PROMPT_SET_VERSION,
          graphVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
          toolVersions: { writerAgent: TOOLSET_VERSIONS.writerAgent },
          codeRevision: sourceRevision(),
        },
      },
    )
    if (targetFailure) throw targetFailure
    expect(report.status).toBe('completed')
    expect(report.trials).toHaveLength(1)
    expect(report.trials[0]?.scores[0]?.passed).toBe(true)
    expect(compareEvalBaseline(report, failureBaseline))
      .toMatchObject({ passed: true, failures: [] })
  }, 30_000)

  it('fences an expired lease and completes through a production takeover', async () => {
    const evalCases: Array<EvalCase<ProductionCompositionInput, ProductionTakeoverObservation>> =
      takeoverFixture.cases.map((takeoverCase) => {
        const workflowCase = workflowFixture.cases.find(
          (scenario) => scenario.id === takeoverCase.workflow_case_id,
        )
        if (!workflowCase) throw new Error(`Missing workflow case ${takeoverCase.workflow_case_id}`)
        return {
          key: `${takeoverFixture.dataset_id}/${takeoverCase.id}`,
          input: {
            id: takeoverCase.id,
            workflowCaseId: workflowCase.id,
            topic: workflowCase.topic,
            initialOutline: workflowCase.initial_outline,
            expectedOutline: workflowCase.expected.outline,
            replies: workflowCase.replies,
            interventionOnOutline: workflowCase.intervention_on_outline,
            fullReviewRounds: workflowCase.full_review_rounds,
            targetWords: takeoverCase.target_words,
          },
          expected: takeoverCase.expected,
          tags: [takeoverFixture.dataset_id, workflowFixture.dataset_id, 'durable', 'takeover'],
        }
      })
    let targetFailure: unknown
    const report = await runOfflineEval(
      evalCases,
      {
        key: 'typescript-durable-production-takeover',
        version: 'v2',
        async execute(input) {
          try {
            return await executeProductionTakeover(input)
          } catch (error) {
            targetFailure = error
            throw error
          }
        },
      },
      [{
        key: 'canonical-production-takeover',
        version: 'v1',
        metric: 'durable_takeover_exact_match',
        evaluate: ({ output, case: evalCase }) => ({
          passed: fingerprintEvalValue(output) === fingerprintEvalValue(evalCase.expected),
        }),
      }],
      {
        suite: { key: 'production-takeover-regression', version: '2026-09-03-v2' },
        execution: {
          modelProfile: 'loopback:anthropic-takeover-v1',
          promptVersion: PROMPT_SET_VERSION,
          graphVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
          toolVersions: { writerAgent: TOOLSET_VERSIONS.writerAgent },
          codeRevision: sourceRevision(),
        },
      },
    )
    if (targetFailure) throw targetFailure
    expect(report.status).toBe('completed')
    expect(report.trials).toHaveLength(1)
    expect(report.trials[0]?.scores[0]?.passed).toBe(true)
    expect(compareEvalBaseline(report, takeoverBaseline))
      .toMatchObject({ passed: true, failures: [] })
  }, 30_000)
})
