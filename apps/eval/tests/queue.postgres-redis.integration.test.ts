import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  assertCurrentEvalRuntimeRole,
  createEvalRepository,
  createPostgresDatabase,
  provisionEvalRuntimeRole,
} from '@vibe-writer/db'
import * as schema from '@vibe-writer/db/schema'
import { fingerprintEvalDataset, type EvalJsonValue } from '@vibe-writer/eval-core'
import { Queue } from 'bullmq'
import { count, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterAll, describe, expect, it } from 'vitest'
import { componentEvalDefinition, COMPONENT_SUITE } from '../src/component-suite.ts'
import { loadEvalQueueConfig } from '../src/queue-config.ts'
import { DEFAULT_EVAL_QUEUE_NAME, evalQueueJobId, type EvalQueueJobData } from '../src/queue-protocol.ts'
import { createEvalQueueRuntime } from '../src/queue-runtime.ts'

const databaseUrl = process.env.TEST_DATABASE_URL
const redisUrl = process.env.TEST_REDIS_URL
const testId = process.env.VIBE_WRITER_EVAL_RUNTIME_TEST_ID
if (!databaseUrl || !redisUrl || !testId || !/^[0-9a-f]{32}$/.test(testId)) {
  throw new Error('Harness-created Eval PostgreSQL and Redis targets are required')
}
for (const target of [databaseUrl, redisUrl]) {
  const parsed = new URL(target)
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port) {
    throw new Error(`Refusing non-loopback Eval integration target ${parsed.host}`)
  }
}
if (!new URL(databaseUrl).pathname.endsWith(testId)) {
  throw new Error('Refusing PostgreSQL database without the Eval harness test id')
}

const integrationDatabaseUrl = databaseUrl
const integrationRedisUrl = redisUrl
const integrationTestId = testId
const dispatcherRole = `eval_dispatcher_${testId}`
const consumerRole = `eval_consumer_${testId}`
const ownerDatabase = createPostgresDatabase(integrationDatabaseUrl, { max: 2 })
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
)

function databaseUrlForRole(role: string): string {
  const url = new URL(integrationDatabaseUrl)
  url.username = role
  url.password = ''
  return url.toString()
}

const dispatcherDatabase = createPostgresDatabase(databaseUrlForRole(dispatcherRole), { max: 1 })
const consumerDatabase = createPostgresDatabase(databaseUrlForRole(consumerRole), { max: 1 })

async function eventually(assertion: () => Promise<void>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

afterAll(async () => {
  await Promise.allSettled([
    dispatcherDatabase.close(),
    consumerDatabase.close(),
    ownerDatabase.close(),
  ])
})

describe('real PostgreSQL and Redis Eval runtime role canary', () => {
  it('completes a queued Eval with separate dispatcher and consumer identities', async () => {
    await migrate(ownerDatabase.db, { migrationsFolder })
    await ownerDatabase.client.unsafe(`CREATE ROLE \"${dispatcherRole}\"`)
    await ownerDatabase.client.unsafe(`CREATE ROLE \"${consumerRole}\"`)
    await provisionEvalRuntimeRole(ownerDatabase.client, 'dispatcher', dispatcherRole)
    await provisionEvalRuntimeRole(ownerDatabase.client, 'consumer', consumerRole)

    await expect(assertCurrentEvalRuntimeRole(
      dispatcherDatabase.client,
      'dispatcher',
      dispatcherRole,
    )).resolves.toMatchObject({ issues: [] })
    await expect(assertCurrentEvalRuntimeRole(
      consumerDatabase.client,
      'consumer',
      consumerRole,
    )).resolves.toMatchObject({ issues: [] })

    const evals = createEvalRepository(ownerDatabase.db)
    const definition = componentEvalDefinition()
    const namespaceKey = `eval-runtime-role-${randomUUID()}`
    await evals.createSuite({
      namespaceKey,
      suiteKey: COMPONENT_SUITE.key,
      version: COMPONENT_SUITE.version,
      name: 'Eval runtime role canary',
      status: 'active',
      dataClassification: 'synthetic',
      cases: definition.cases.map((item) => ({
        key: item.key,
        input: item.input as unknown as EvalJsonValue,
        expected: item.expected,
        tags: item.tags,
      })),
    })
    const queued = await evals.enqueueRun({
      namespaceKey,
      suiteKey: COMPONENT_SUITE.key,
      suiteVersion: COMPONENT_SUITE.version,
      datasetFingerprint: fingerprintEvalDataset(definition.cases),
      trigger: 'regression',
      targetKey: definition.target.key,
      targetVersion: definition.target.version,
      execution: definition.options.execution,
      trialsPerCase: 1,
      idempotencyKey: `eval-runtime-role-${randomUUID()}`,
    })

    const prefix = `vibe-writer-eval-role-${testId}`
    const config = loadEvalQueueConfig({
      EVAL_QUEUE_ENABLED: 'true',
      EVAL_QUEUE_ROLE: 'all',
      DATABASE_EVAL_DISPATCHER_URL: databaseUrlForRole(dispatcherRole),
      EVAL_DISPATCHER_DATABASE_ROLE: dispatcherRole,
      DATABASE_EVAL_CONSUMER_URL: databaseUrlForRole(consumerRole),
      EVAL_CONSUMER_DATABASE_ROLE: consumerRole,
      EVAL_REDIS_URL: integrationRedisUrl,
      EVAL_WORKER_ID: `eval-role-${integrationTestId}`,
      EVAL_BULLMQ_PREFIX: prefix,
      EVAL_WORKER_CONCURRENCY: '1',
      EVAL_LEASE_DURATION_MS: '2000',
      EVAL_HEARTBEAT_INTERVAL_MS: '250',
      EVAL_BULLMQ_LOCK_DURATION_MS: '2000',
      EVAL_OUTBOX_POLL_MS: '25',
      EVAL_OUTBOX_BATCH_SIZE: '10',
      EVAL_GRADER_ENABLED: 'false',
      EVAL_MEMORY_CALIBRATION_ENABLED: 'false',
    })
    const runtime = createEvalQueueRuntime(config)
    const queue = new Queue<EvalQueueJobData>(DEFAULT_EVAL_QUEUE_NAME, {
      connection: config.redis,
      prefix,
    })
    try {
      await runtime.start()
      await eventually(async () => {
        expect((await evals.getRun(queued.run.id))?.status).toBe('completed')
      })
      const queueJob = await queue.getJob(evalQueueJobId(queued.run.id))
      expect(queueJob?.data).toEqual({ schemaVersion: 1, evalRunId: queued.run.id })
      expect(await queueJob?.getState()).toBe('completed')
    } finally {
      await runtime.close()
      await queue.close()
    }

    const [trialCount] = await ownerDatabase.db
      .select({ value: count() })
      .from(schema.evalTrials)
      .where(eq(schema.evalTrials.evalRunId, queued.run.id))
    const [scoreCount] = await ownerDatabase.db
      .select({ value: count() })
      .from(schema.evalScores)
      .innerJoin(schema.evalTrials, eq(schema.evalScores.trialId, schema.evalTrials.id))
      .where(eq(schema.evalTrials.evalRunId, queued.run.id))
    expect(trialCount?.value).toBe(38)
    expect(scoreCount?.value).toBe(38)

    await expect(dispatcherDatabase.client`SELECT id FROM eval_runs LIMIT 1`).rejects.toThrow()
    await expect(consumerDatabase.client`SELECT id FROM outbox_events LIMIT 1`).rejects.toThrow()
    await expect(dispatcherDatabase.client`CREATE SCHEMA forbidden_dispatcher`).rejects.toThrow()
    await expect(consumerDatabase.client`CREATE SCHEMA forbidden_consumer`).rejects.toThrow()
  })
})
