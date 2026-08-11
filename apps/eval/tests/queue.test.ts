import { randomUUID } from 'node:crypto'
import { UnrecoverableError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import { processBullMqEvalJob } from '../src/bullmq.ts'
import { loadEvalQueueConfig, loadLiveGraderConfig } from '../src/queue-config.ts'
import {
  EVAL_QUEUE_JOB_NAME,
  EVAL_QUEUE_SCHEMA_VERSION,
  EvalOutboxDispatcher,
  RetryableEvalQueueDeliveryError,
  evalQueueJobId,
  processEvalQueueJob,
} from '../src/queue-protocol.ts'

describe('Eval queue protocol', () => {
  it('accepts only the versioned pointer payload', async () => {
    const evalRunId = randomUUID()
    const runner = { run: vi.fn(async () => ({ status: 'completed' as const, evalRunId })) }
    await expect(processEvalQueueJob({
      name: EVAL_QUEUE_JOB_NAME,
      data: { schemaVersion: EVAL_QUEUE_SCHEMA_VERSION, evalRunId },
    }, runner)).resolves.toEqual({ status: 'completed', evalRunId })
    expect(runner.run).toHaveBeenCalledWith(evalRunId)
    expect(evalQueueJobId(evalRunId)).toBe(`eval-${evalRunId}`)
  })

  it('makes malformed payloads unrecoverable at the BullMQ boundary', async () => {
    await expect(processBullMqEvalJob({
      name: EVAL_QUEUE_JOB_NAME,
      data: {
        schemaVersion: 1,
        evalRunId: randomUUID(),
        input: 'must-not-travel',
      } as unknown as { schemaVersion: 1; evalRunId: string },
    }, { run: vi.fn() })).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('retries a delivery while another database lease owns the run', async () => {
    const evalRunId = randomUUID()
    await expect(processEvalQueueJob({
      name: EVAL_QUEUE_JOB_NAME,
      data: { schemaVersion: EVAL_QUEUE_SCHEMA_VERSION, evalRunId },
    }, {
      run: vi.fn(async () => ({ status: 'not_claimed' as const, reason: 'busy' as const })),
    })).rejects.toBeInstanceOf(RetryableEvalQueueDeliveryError)
  })

  it('claims only Eval outbox rows and publishes a deterministic pointer', async () => {
    const evalRunId = randomUUID()
    const eventId = randomUUID()
    const claimBatch = vi.fn(async () => [{
      id: eventId,
      idempotencyKey: `eval:${evalRunId}:enqueue:v1`,
      aggregateType: 'eval_run',
      aggregateId: evalRunId,
      eventType: 'eval.run.requested',
      payload: { evalRunId },
      status: 'publishing' as const,
      attempts: 1,
      availableAt: new Date(),
      lockedBy: 'dispatcher',
      lockToken: randomUUID(),
      lockedAt: new Date(),
      publishedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }])
    const enqueue = vi.fn(async () => undefined)
    const dispatcher = new EvalOutboxDispatcher({
      claimBatch,
      markPublished: vi.fn(async () => 'published' as const),
      releaseFailure: vi.fn(async () => 'released' as const),
    }, { enqueue }, {
      dispatcherId: 'eval-dispatcher',
      batchSize: 10,
      lockTimeoutMs: 1_000,
      maxAttempts: 3,
      initialBackoffMs: 10,
      maxBackoffMs: 100,
    })
    await expect(dispatcher.dispatchBatch()).resolves.toEqual([{
      eventId,
      status: 'published',
      queueJobId: evalQueueJobId(evalRunId),
    }])
    expect(claimBatch).toHaveBeenCalledWith(expect.objectContaining({
      aggregateType: 'eval_run',
    }))
    expect(enqueue).toHaveBeenCalledWith(EVAL_QUEUE_JOB_NAME, {
      schemaVersion: EVAL_QUEUE_SCHEMA_VERSION,
      evalRunId,
    }, { jobId: evalQueueJobId(evalRunId) })
  })
})

describe('Eval queue configuration', () => {
  const databaseEnvironment = {
    DATABASE_EVAL_DISPATCHER_URL: 'postgres://eval_dispatcher@localhost/eval',
    EVAL_DISPATCHER_DATABASE_ROLE: 'eval_dispatcher',
    DATABASE_EVAL_CONSUMER_URL: 'postgres://eval_consumer@localhost/eval',
    EVAL_CONSUMER_DATABASE_ROLE: 'eval_consumer',
  }

  it('rejects sharing the write queue name', () => {
    expect(() => loadEvalQueueConfig({
      EVAL_QUEUE_ENABLED: 'true',
      EVAL_DATABASE_URL: 'postgres://localhost/eval',
      EVAL_REDIS_URL: 'redis://localhost:6379',
      EVAL_WORKER_ID: 'eval-worker',
      EVAL_QUEUE_NAME: 'vibe-writer-write',
    })).toThrow('must use different queue names')
  })

  it('requires independent runtime identities and has no general database fallback', () => {
    const base = {
      EVAL_QUEUE_ENABLED: 'true',
      EVAL_REDIS_URL: 'redis://localhost:6379',
      EVAL_WORKER_ID: 'eval-worker',
      ...databaseEnvironment,
    }
    expect(loadEvalQueueConfig(base)).toMatchObject({
      role: 'all',
      dispatcherDatabase: {
        url: databaseEnvironment.DATABASE_EVAL_DISPATCHER_URL,
        role: databaseEnvironment.EVAL_DISPATCHER_DATABASE_ROLE,
      },
      consumerDatabase: {
        url: databaseEnvironment.DATABASE_EVAL_CONSUMER_URL,
        role: databaseEnvironment.EVAL_CONSUMER_DATABASE_ROLE,
      },
    })
    expect(() => loadEvalQueueConfig({
      ...base,
      DATABASE_EVAL_CONSUMER_URL: base.DATABASE_EVAL_DISPATCHER_URL,
    })).toThrow('URLs must be distinct')
    expect(() => loadEvalQueueConfig({
      ...base,
      EVAL_CONSUMER_DATABASE_ROLE: base.EVAL_DISPATCHER_DATABASE_ROLE,
    })).toThrow('roles must be distinct')
    expect(() => loadEvalQueueConfig({
      ...base,
      EVAL_DATABASE_URL: 'postgres://owner@localhost/eval',
      DATABASE_EVAL_CONSUMER_URL: undefined,
    })).toThrow('DATABASE_EVAL_CONSUMER_URL')
  })

  it('does not load consumer provider credentials for a dispatcher-only process', () => {
    expect(loadEvalQueueConfig({
      EVAL_QUEUE_ENABLED: 'true',
      EVAL_QUEUE_ROLE: 'dispatcher',
      EVAL_REDIS_URL: 'redis://localhost:6379',
      EVAL_WORKER_ID: 'eval-dispatcher',
      DATABASE_EVAL_DISPATCHER_URL: databaseEnvironment.DATABASE_EVAL_DISPATCHER_URL,
      EVAL_DISPATCHER_DATABASE_ROLE: databaseEnvironment.EVAL_DISPATCHER_DATABASE_ROLE,
      EVAL_GRADER_ENABLED: 'true',
      EVAL_MEMORY_CALIBRATION_ENABLED: 'true',
    })).toMatchObject({ role: 'dispatcher', grader: null, memoryCalibration: null })
  })

  it('requires an explicit versioned pricing and budget snapshot for live grading', () => {
    expect(() => loadLiveGraderConfig({ EVAL_GRADER_ENABLED: 'true' }))
      .toThrow('EVAL_CODE_REVISION is required')
    expect(loadLiveGraderConfig({})).toBeNull()
    expect(loadLiveGraderConfig({
      EVAL_GRADER_ENABLED: 'true',
      EVAL_CODE_REVISION: 'grader-test',
      EVAL_GRADER_ANTHROPIC_API_KEY: 'secret',
      EVAL_GRADER_ANTHROPIC_MODEL: 'claude-test',
      EVAL_GRADER_KEY: 'anthropic-article-quality',
      EVAL_GRADER_VERSION: 'v1',
      EVAL_GRADER_MODEL_PROFILE: 'anthropic-grader-test',
      EVAL_GRADER_PROMPT_VERSION: 'article-quality-grader-v1',
      EVAL_GRADER_MAX_OUTPUT_TOKENS: '512',
      EVAL_GRADER_PRICING_VERSION: 'pricing-v1',
      EVAL_GRADER_INPUT_MICROUSD_PER_MTOK: '3000000',
      EVAL_GRADER_OUTPUT_MICROUSD_PER_MTOK: '15000000',
      EVAL_GRADER_CACHE_READ_MICROUSD_PER_MTOK: '300000',
      EVAL_GRADER_CACHE_WRITE_MICROUSD_PER_MTOK: '3750000',
      EVAL_GRADER_MAX_CALLS_PER_RUN: '10',
      EVAL_GRADER_MAX_COST_MICROUSD_PER_RUN: '100000',
    })).toMatchObject({
      codeRevision: 'grader-test',
      pricing: { version: 'pricing-v1' },
      budget: { maxCalls: 10, maxCostMicrousd: 100000 },
    })
  })
})
