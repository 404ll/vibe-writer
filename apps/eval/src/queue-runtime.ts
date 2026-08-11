import {
  assertCurrentEvalRuntimeRole,
  createEvalRepository,
  createMemoryCalibrationAuthorizationRepository,
  createOutboxRepository,
  createPostgresDatabase,
} from '@vibe-writer/db'
import { BullMqEvalPublisher, BullMqEvalWorker } from './bullmq.ts'
import { ComponentEvalQueueExecutor } from './component-queue-executor.ts'
import { AnthropicModel } from '@vibe-writer/provider-runtime'
import { EvalQueueExecutorRegistry } from './executor-registry.ts'
import { LiveArticleGraderExecutor } from './live-article-grader-executor.ts'
import { MemoryCalibrationQueueExecutor } from './memory-calibration-queue-executor.ts'
import type { EvalQueueConfig } from './queue-config.ts'
import { EvalOutboxDispatcher } from './queue-protocol.ts'
import { DurableEvalQueueRunner } from './queue-runner.ts'

function report(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown Eval queue error'
  console.error(JSON.stringify({ level: 'error', scope, message }))
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function createEvalQueueRuntime(config: EvalQueueConfig) {
  const dispatcherEnabled = config.role === 'all' || config.role === 'dispatcher'
  const consumerEnabled = config.role === 'all' || config.role === 'consumer'
  const dispatcherDatabase = dispatcherEnabled
    ? createPostgresDatabase(config.dispatcherDatabase!.url, { max: 4 })
    : null
  const consumerDatabase = consumerEnabled
    ? createPostgresDatabase(config.consumerDatabase!.url, {
        max: Math.max(6, config.concurrency + 4),
      })
    : null
  const publisher = dispatcherEnabled
    ? new BullMqEvalPublisher({
        queueName: config.queueName,
        connection: config.redis,
        ...(config.queuePrefix ? { prefix: config.queuePrefix } : {}),
      })
    : null
  const dispatcher = publisher
    ? new EvalOutboxDispatcher(createOutboxRepository(dispatcherDatabase!.db), publisher, {
        dispatcherId: `${config.workerId}:eval-dispatcher`,
        batchSize: config.dispatchBatchSize,
        lockTimeoutMs: 30_000,
        maxAttempts: 20,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
      })
    : null
  const consumer = consumerEnabled
    ? new BullMqEvalWorker(
        new DurableEvalQueueRunner(
          createEvalRepository(consumerDatabase!.db),
          new EvalQueueExecutorRegistry(
            new ComponentEvalQueueExecutor(),
            config.grader
              ? new LiveArticleGraderExecutor(
                  new AnthropicModel(config.grader.anthropic),
                  config.grader,
                  config.grader.codeRevision,
                )
              : null,
            config.memoryCalibration
              ? new MemoryCalibrationQueueExecutor(
                  createMemoryCalibrationAuthorizationRepository(consumerDatabase!.db),
                  new AnthropicModel(config.memoryCalibration.anthropic),
                )
              : null,
          ),
          {
            workerId: config.workerId,
            leaseDurationMs: config.leaseDurationMs,
            heartbeatIntervalMs: config.heartbeatIntervalMs,
          },
        ),
        {
          queueName: config.queueName,
          connection: config.redis,
          ...(config.queuePrefix ? { prefix: config.queuePrefix } : {}),
          workerName: config.workerId,
          concurrency: config.concurrency,
          lockDurationMs: config.lockDurationMs,
          observer: {
            error: (error) => report('eval.bullmq.error', error),
            failed: (jobId, error) => report(`eval.bullmq.failed:${jobId ?? 'unknown'}`, error),
            stalled: (jobId) => report(
              `eval.bullmq.stalled:${jobId}`,
              new Error('Eval queue job stalled'),
            ),
          },
        },
      )
    : null
  const stop = new AbortController()
  let dispatchLoop: Promise<void> | null = null
  let started = false
  let closed = false

  return {
    async start() {
      if (started) throw new Error('Eval queue runtime already started')
      started = true
      if (dispatcherDatabase) {
        await assertCurrentEvalRuntimeRole(
          dispatcherDatabase.client,
          'dispatcher',
          config.dispatcherDatabase!.role,
        )
        const [schema] = await dispatcherDatabase.client<{ ready: boolean }[]>`
          select to_regclass('public.outbox_events') is not null as ready
        `
        if (schema?.ready !== true) {
          throw new Error('Eval dispatcher database schema is incomplete')
        }
      }
      if (consumerDatabase) {
        await assertCurrentEvalRuntimeRole(
          consumerDatabase.client,
          'consumer',
          config.consumerDatabase!.role,
        )
        const [schema] = await consumerDatabase.client<{ ready: boolean }[]>`
          select (
            to_regclass('public.eval_suites') is not null
            and to_regclass('public.eval_cases') is not null
            and to_regclass('public.eval_runs') is not null
            and to_regclass('public.eval_trials') is not null
            and to_regclass('public.eval_scores') is not null
            and to_regclass('public.eval_candidates') is not null
            and to_regclass('public.memory_calibration_authorizations') is not null
          ) as ready
        `
        if (schema?.ready !== true) {
          throw new Error('Eval consumer database schema is incomplete')
        }
      }
      if (publisher) await publisher.waitUntilReady()
      if (consumer) await consumer.start()
      if (dispatcher) {
        dispatchLoop = (async () => {
          while (!stop.signal.aborted) {
            try {
              await dispatcher.dispatchBatch()
            } catch (error) {
              report('eval.outbox.dispatch', error)
            }
            await sleep(config.dispatchPollMs, stop.signal)
          }
        })()
      }
    },
    async close() {
      if (closed) return
      closed = true
      stop.abort('shutdown')
      await dispatchLoop
      if (consumer) await consumer.close(false)
      if (publisher) await publisher.close()
      await Promise.all([
        dispatcherDatabase?.close(),
        consumerDatabase?.close(),
      ])
    },
  }
}
