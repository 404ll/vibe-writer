import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import {
  createEvalCandidateRepository,
  createEvalMaterializationRepository,
  createEvalRepository,
  createJobRepository,
  createOutboxRepository,
  createTerminalRepository,
  createWorkspaceRepository,
} from '@vibe-writer/db'
import * as schema from '@vibe-writer/db/schema'
import { fingerprintEvalDataset, type EvalJsonValue } from '@vibe-writer/eval-core'
import { AnthropicModel } from '@vibe-writer/provider-runtime'
import { Queue } from 'bullmq'
import { count, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BullMqEvalPublisher,
  BullMqEvalWorker,
} from '../src/bullmq.ts'
import { ComponentEvalQueueExecutor } from '../src/component-queue-executor.ts'
import {
  LIVE_ARTICLE_GRADER_TARGET,
  LiveArticleGraderExecutor,
  liveArticleGraderExecution,
} from '../src/live-article-grader-executor.ts'
import type { LiveGraderConfig } from '../src/queue-config.ts'
import {
  COMPONENT_SUITE,
  componentEvalDefinition,
} from '../src/component-suite.ts'
import {
  DEFAULT_EVAL_QUEUE_NAME,
  EvalOutboxDispatcher,
  evalQueueJobId,
  type EvalQueueJobData,
} from '../src/queue-protocol.ts'
import { DurableEvalQueueRunner } from '../src/queue-runner.ts'

const redisUrl = process.env.TEST_REDIS_URL
const testId = process.env.VIBE_WRITER_EVAL_REDIS_TEST_ID
if (!redisUrl || !testId || !/^[0-9a-f]{32}$/.test(testId)) {
  throw new Error('Harness-created Redis target is required')
}
const parsed = new URL(redisUrl)
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.port) {
  throw new Error(`Refusing non-loopback Redis target ${parsed.host}`)
}
const connection = {
  host: parsed.hostname,
  port: Number(parsed.port),
  maxRetriesPerRequest: null,
}
const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
)
const closers: Array<() => Promise<unknown>> = []

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()))
})

async function eventually(assertion: () => Promise<void>, timeoutMs = 10_000) {
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

describe.sequential('independent Eval queue Redis integration', () => {
  it('delivers only an Eval run pointer and atomically commits a content-free report', async () => {
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const evals = createEvalRepository(db)
    const outbox = createOutboxRepository(db)
    const definition = componentEvalDefinition()
    const namespaceKey = `eval-redis-${randomUUID()}`
    const suite = await evals.createSuite({
      namespaceKey,
      suiteKey: COMPONENT_SUITE.key,
      version: COMPONENT_SUITE.version,
      name: 'TypeScript component regression',
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
      idempotencyKey: `eval-redis-run-${randomUUID()}`,
    })
    const prefix = `vibe-writer-eval-test-${testId}-${randomUUID()}`
    const publisher = new BullMqEvalPublisher({ connection, prefix })
    const dispatcher = new EvalOutboxDispatcher(outbox, publisher, {
      dispatcherId: 'eval-redis-dispatcher',
      batchSize: 10,
      lockTimeoutMs: 30_000,
      maxAttempts: 3,
      initialBackoffMs: 10,
      maxBackoffMs: 100,
    })
    const runner = new DurableEvalQueueRunner(
      evals,
      new ComponentEvalQueueExecutor(),
      { workerId: 'eval-redis-worker', leaseDurationMs: 2_000, heartbeatIntervalMs: 250 },
    )
    const observer = { error: vi.fn(), failed: vi.fn(), stalled: vi.fn() }
    const worker = new BullMqEvalWorker(runner, {
      connection,
      prefix,
      workerName: 'eval-redis-worker',
      concurrency: 1,
      lockDurationMs: 2_000,
      stalledIntervalMs: 200,
      observer,
    })
    const evalQueue = new Queue<EvalQueueJobData>(DEFAULT_EVAL_QUEUE_NAME, {
      connection,
      prefix,
    })
    const writeQueue = new Queue('vibe-writer-write', { connection, prefix })
    closers.push(
      () => publisher.close(),
      () => worker.close(),
      () => evalQueue.close(),
      () => writeQueue.close(),
      () => client.close(),
    )

    await writeQueue.add('write.run', { schemaVersion: 1, jobId: randomUUID() })
    await expect(dispatcher.dispatchBatch()).resolves.toEqual([{
      eventId: expect.any(String),
      status: 'published',
      queueJobId: evalQueueJobId(queued.run.id),
    }])
    const queueJob = await evalQueue.getJob(evalQueueJobId(queued.run.id))
    expect(queueJob?.data).toEqual({ schemaVersion: 1, evalRunId: queued.run.id })
    expect(JSON.stringify(queueJob?.data)).not.toContain('planner_outline')
    await expect(dispatcher.dispatchBatch()).resolves.toEqual([])

    await worker.start()
    await eventually(async () => {
      expect(await queueJob?.getState()).toBe('completed')
      expect((await evals.getRun(queued.run.id))?.status).toBe('completed')
    })

    const [trialCount] = await db
      .select({ value: count() })
      .from(schema.evalTrials)
      .where(eq(schema.evalTrials.evalRunId, queued.run.id))
    const [scoreCount] = await db
      .select({ value: count() })
      .from(schema.evalScores)
      .innerJoin(schema.evalTrials, eq(schema.evalScores.trialId, schema.evalTrials.id))
      .where(eq(schema.evalTrials.evalRunId, queued.run.id))
    const trials = await db
      .select({ output: schema.evalTrials.output })
      .from(schema.evalTrials)
      .where(eq(schema.evalTrials.evalRunId, queued.run.id))
    const [event] = await db
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, queued.run.id))
    expect(suite.suite.datasetFingerprint).toBe(queued.run.datasetFingerprint)
    expect(trialCount?.value).toBe(38)
    expect(scoreCount?.value).toBe(38)
    expect(trials.every((trial) => trial.output === null)).toBe(true)
    expect(event).toMatchObject({ aggregateType: 'eval_run', status: 'published' })
    expect(await writeQueue.getJobCounts('waiting')).toMatchObject({ waiting: 1 })
    expect(observer.failed).not.toHaveBeenCalled()
  })

  it('runs an approved live dataset through the durable queue with metered model grading', async () => {
    const client = await PGlite.create()
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder })
    const workspace = await createWorkspaceRepository(db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `grader-${randomUUID().slice(0, 8)}`,
      name: 'Live grader Redis test',
    })
    const jobs = createJobRepository(db)
    const created = await jobs.createJob({
      workspaceId: workspace.workspaceId,
      createdByPrincipalId: workspace.principalId,
      idempotencyKey: `grader-source-${randomUUID()}`,
      topic: 'Live grader private topic',
      intervention: { on_outline: false },
    })
    const claim = await jobs.claimJob({
      jobId: created.job.id,
      workerId: 'grader-source-worker',
      leaseDurationMs: 30_000,
      execution: {
        modelProfile: { profile: 'scripted', provider: 'scripted', model: 'scripted-v1' },
        promptVersion: 'prompt-v1',
        graphVersion: 'writer-graph-v1-target-2026-08-07',
        toolVersions: { writer: 'writer-v1' },
        codeRevision: 'grader-source-test',
      },
    })
    if (!claim) throw new Error('Expected live grader source claim')
    const terminal = await createTerminalRepository(db).completeClaim({
      jobId: created.job.id,
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
      exportIdempotencyKey: `job:${created.job.id}:article:export`,
      topic: 'Live grader private topic',
      markdown: '# Approved live article\n\nA coherent body for grading.',
      outputPath: null,
    })
    if (!('article' in terminal)) throw new Error('Expected live grader source article')
    const candidates = createEvalCandidateRepository(db)
    const sampled = await candidates.sampleCompletedRun({
      sourceRunId: claim.run.id,
      samplerKey: 'live-grader-redis',
      samplerVersion: 'v1',
      sampleRateBps: 10_000,
      consent: { basis: 'workspace_policy', policyVersion: 'consent-v1' },
      retentionUntil: new Date(Date.now() + 86_400_000),
    })
    if (sampled.status !== 'selected') throw new Error('Expected live grader candidate')
    await candidates.reviewCandidate(workspace, {
      candidateId: sampled.candidate.id,
      decision: 'approved',
      reasonCode: 'approved_for_live_grader',
    })
    const materialization = createEvalMaterializationRepository(db)
    const materialized = await materialization.materializeApprovedCandidates(workspace, {
      candidateIds: [sampled.candidate.id],
      suiteKey: 'approved-live-articles',
      suiteVersion: 'v1',
      name: 'Approved live articles',
      materializerKey: 'approved-article-copy',
      materializerVersion: 'v1',
    })
    await materialization.activateMaterializedSuite(workspace, materialized.suite.id)

    const graderConfig: LiveGraderConfig = {
      codeRevision: 'live-grader-redis-test',
      anthropic: { apiKey: 'test-key', model: 'claude-test', timeoutMs: 5_000 },
      profile: {
        key: 'anthropic-article-quality',
        version: 'v1',
        modelProfile: 'anthropic-grader-test',
        promptVersion: 'article-quality-grader-v1',
        maxOutputTokens: 512,
      },
      pricing: {
        version: 'anthropic-test-pricing-v1',
        inputMicrousdPerMillionTokens: 3_000_000,
        outputMicrousdPerMillionTokens: 15_000_000,
        cacheReadMicrousdPerMillionTokens: 300_000,
        cacheWriteMicrousdPerMillionTokens: 3_750_000,
      },
      budget: { maxCalls: 2, maxCostMicrousd: 50_000 },
    }
    const evals = createEvalRepository(db)
    const queued = await evals.enqueueRun({
      namespaceKey: materialized.suite.namespaceKey,
      suiteKey: materialized.suite.suiteKey,
      suiteVersion: materialized.suite.version,
      datasetFingerprint: materialized.suite.datasetFingerprint,
      trigger: 'manual',
      targetKey: LIVE_ARTICLE_GRADER_TARGET.key,
      targetVersion: LIVE_ARTICLE_GRADER_TARGET.version,
      execution: liveArticleGraderExecution(graderConfig, graderConfig.codeRevision),
      trialsPerCase: 2,
      idempotencyKey: `live-grader-${randomUUID()}`,
    })
    const providerFetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'live-grader-request',
      model: 'claude-test',
      content: [{
        type: 'text',
        text: JSON.stringify({
          criteria: [
            'focus_and_intent',
            'coherence',
            'substantive_coverage',
            'evidence_discipline',
            'readability',
          ].map((key) => ({ key, score: 80, reasonCode: 'meets_expectations' })),
        }),
      }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'request-id': 'live-grader-request',
      },
    }))
    const prefix = `vibe-writer-live-grader-${testId}-${randomUUID()}`
    const publisher = new BullMqEvalPublisher({ connection, prefix })
    const dispatcher = new EvalOutboxDispatcher(
      createOutboxRepository(db),
      publisher,
      {
        dispatcherId: 'live-grader-dispatcher',
        batchSize: 10,
        lockTimeoutMs: 30_000,
        maxAttempts: 3,
        initialBackoffMs: 10,
        maxBackoffMs: 100,
      },
    )
    const runner = new DurableEvalQueueRunner(
      evals,
      new LiveArticleGraderExecutor(
        new AnthropicModel({ ...graderConfig.anthropic, fetch: providerFetch }),
        graderConfig,
        graderConfig.codeRevision,
      ),
      { workerId: 'live-grader-worker', leaseDurationMs: 2_000, heartbeatIntervalMs: 250 },
    )
    const worker = new BullMqEvalWorker(runner, {
      connection,
      prefix,
      workerName: 'live-grader-worker',
      concurrency: 1,
      lockDurationMs: 2_000,
      stalledIntervalMs: 200,
      observer: { error: vi.fn(), failed: vi.fn(), stalled: vi.fn() },
    })
    const evalQueue = new Queue<EvalQueueJobData>(DEFAULT_EVAL_QUEUE_NAME, {
      connection,
      prefix,
    })
    closers.push(
      () => publisher.close(),
      () => worker.close(),
      () => evalQueue.close(),
      () => client.close(),
    )

    await dispatcher.dispatchBatch()
    await worker.start()
    await eventually(async () => {
      expect((await evals.getRun(queued.run.id))?.status).toBe('completed')
    })
    expect(providerFetch).toHaveBeenCalledTimes(2)
    const scores = await db
      .select()
      .from(schema.evalScores)
      .innerJoin(schema.evalTrials, eq(schema.evalScores.trialId, schema.evalTrials.id))
      .where(eq(schema.evalTrials.evalRunId, queued.run.id))
    expect(scores).toHaveLength(2)
    expect(scores.every((row) => row.eval_scores.passed === true)).toBe(true)
    expect(scores[0]?.eval_scores).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test',
      providerRequestId: 'live-grader-request',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      costMicrousd: 1_050,
      pricingVersion: graderConfig.pricing.version,
      costCurrency: 'USD',
    })
    expect(scores.every((row) => row.eval_trials.output === null)).toBe(true)
  })
})
