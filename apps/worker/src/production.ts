import { createPostgresSaver } from '@vibe-writer/checkpoint-runtime'
import {
  PROMPT_SET_VERSION,
  TOOLSET_VERSIONS,
} from '@vibe-writer/agent-core'
import {
  createCheckpointRepository,
  createCommandRepository,
  createJobRepository,
  createOutboxRepository,
  createPostgresDatabase,
  createTerminalRepository,
  assertCurrentWriteRuntimeRole,
} from '@vibe-writer/db'
import { AnthropicModel, TavilySearchProvider } from '@vibe-writer/provider-runtime'
import { WORKFLOW_VERSION } from '@vibe-writer/workflow-runtime'
import { BullMqWritePublisher, BullMqWriteWorker } from './bullmq-adapter'
import { loadProductionWorkerConfig, type ProductionWorkerConfig } from './config'
import { createWorkerLeaseControl } from './control'
import { OutboxDispatcher } from './outbox-dispatcher'
import { WorkerProcessRuntime } from './process-runtime'
import { WorkerJobRunner } from './runner'
import {
  DurableWorkflowExecutor,
  createFencedWorkflowCheckpointFactory,
} from './workflow-executor'
import { createWorkflowServices } from './workflow-services'
import {
  EffectJournalModel,
  EffectJournalSearchProvider,
} from './effect-journal'
import { WorkerHealthServer } from './health-server'

function report(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown runtime error'
  console.error(JSON.stringify({ level: 'error', scope, message }))
}

export function createProductionWorkerRuntime(config: ProductionWorkerConfig) {
  // 调度器与消费者即使部署在同一进程，也必须使用两个数据库身份：
  // 前者只搬运事务发件箱，后者只执行任务，避免任一连接意外获得完整数据面权限。
  const dispatcherEnabled = config.role === 'all' || config.role === 'dispatcher'
  const consumerEnabled = config.role === 'all' || config.role === 'consumer'
  const dispatcherDatabase = dispatcherEnabled
    ? createPostgresDatabase(config.dispatcherDatabase!.url, { max: 4 })
    : null
  const consumerDatabase = consumerEnabled
    ? createPostgresDatabase(config.consumerDatabase!.url, {
        max: Math.max(10, config.concurrency + 5),
      })
    : null
  const health = config.health ? new WorkerHealthServer(config.health) : null

  const publisher = dispatcherEnabled
    ? new BullMqWritePublisher({
        queueName: config.queueName,
        connection: config.redis,
        ...(config.queuePrefix ? { prefix: config.queuePrefix } : {}),
      })
    : null
  const dispatcher = publisher
    ? new OutboxDispatcher(createOutboxRepository(dispatcherDatabase!.db), publisher, {
        dispatcherId: `${config.workerId}:dispatcher`,
        batchSize: config.dispatchBatchSize,
        lockTimeoutMs: 30_000,
        maxAttempts: 20,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
      })
    : null

  const saver = consumerEnabled
    ? createPostgresSaver(config.consumerDatabase!.url)
    : null
  let consumer: BullMqWriteWorker | null = null
  if (consumerEnabled) {
    const model = new AnthropicModel({
      apiKey: config.anthropicApiKey!,
      model: config.modelId!,
      ...(config.anthropicBaseUrl ? { baseUrl: config.anthropicBaseUrl } : {}),
      ...(config.anthropicThinkingMode
        ? { thinkingMode: config.anthropicThinkingMode }
        : {}),
    })
    const search = config.tavilyApiKey
      ? new TavilySearchProvider({
          apiKey: config.tavilyApiKey,
          ...(config.tavilyBaseUrl ? { baseUrl: config.tavilyBaseUrl } : {}),
        })
      : undefined
    const jobs = createJobRepository(consumerDatabase!.db)
    // 从外到内依次组装传输层、持久化租约、工作流和供应商接口。
    // 领域包不读取环境变量，也不知道 BullMQ、PostgreSQL 或 Anthropic 开发包。
    const runner = new WorkerJobRunner(
      createWorkerLeaseControl(jobs, createTerminalRepository(consumerDatabase!.db)),
      new DurableWorkflowExecutor(
        (context) => {
          const identity = {
            jobId: context.jobId,
            runId: context.runId,
            leaseToken: context.leaseToken,
          }
          return createWorkflowServices(
            new EffectJournalModel(model, jobs, identity),
            search
              ? new EffectJournalSearchProvider(search, jobs, identity)
              : undefined,
          )
        },
        createFencedWorkflowCheckpointFactory(
          saver!,
          createCheckpointRepository(consumerDatabase!.db),
        ),
        createCommandRepository(consumerDatabase!.db),
      ),
      {
        workerId: config.workerId,
        leaseDurationMs: config.leaseDurationMs,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        requestMemoryExtraction: false,
        execution: {
          modelProfile: {
            profile: `anthropic:${config.modelId}:thinking-${config.anthropicThinkingMode ?? 'provider-default'}`,
            provider: 'anthropic',
            model: config.modelId!,
          },
          promptVersion: PROMPT_SET_VERSION,
          graphVersion: WORKFLOW_VERSION,
          toolVersions: { writer: TOOLSET_VERSIONS.writer },
          codeRevision: config.codeRevision,
        },
      },
    )
    consumer = new BullMqWriteWorker(runner, {
      queueName: config.queueName,
      connection: config.redis,
      ...(config.queuePrefix ? { prefix: config.queuePrefix } : {}),
      workerName: config.workerId,
      concurrency: config.concurrency,
      lockDurationMs: config.lockDurationMs,
      observer: {
        error: (error) => report('bullmq.error', error),
        failed: (jobId, error) => report(`bullmq.failed:${jobId ?? 'unknown'}`, error),
        stalled: (jobId) => report(`bullmq.stalled:${jobId}`, new Error('Queue job stalled')),
      },
    })
  }

  return new WorkerProcessRuntime({
    ...(health ? {
      startHealth: () => health.start(),
      markReady: () => health.markReady(),
      markDraining: () => health.markDraining(),
      closeHealth: () => health.close(),
    } : {}),
    checkDatabase: async () => {
      if (dispatcherDatabase) {
        await assertCurrentWriteRuntimeRole(
          dispatcherDatabase.client,
          'dispatcher',
          config.dispatcherDatabase!.role,
        )
        const [dispatcherSchema] = await dispatcherDatabase.client<{ ready: boolean }[]>`
          select to_regclass('public.outbox_events') is not null as ready
        `
        if (dispatcherSchema?.ready !== true) {
          throw new Error('Write dispatcher database schema is incomplete')
        }
      }
      if (consumerDatabase) {
        await assertCurrentWriteRuntimeRole(
          consumerDatabase.client,
          'consumer',
          config.consumerDatabase!.role,
          config.consumerAccessMode,
        )
        if (config.consumerAccessMode === 'single-workspace') {
          // jobs 的 RLS 在更新时同时校验 workspace 与创建者。托管数据库无法授予
          // BYPASSRLS，因此单用户 Consumer 必须在连接建立时固定两层身份。
          const [session] = await consumerDatabase.client<{
            workspaceId: string | null
            principalId: string | null
          }[]>`
            select
              nullif(current_setting('app.workspace_id', true), '') as "workspaceId",
              nullif(current_setting('app.principal_id', true), '') as "principalId"
          `
          if (
            session?.workspaceId !== config.singleWorkspaceId ||
            session?.principalId !== config.singlePrincipalId
          ) {
            throw new Error('Write consumer single-workspace database session is not fully scoped')
          }
        }
        const [consumerSchema] = await consumerDatabase.client<{ ready: boolean }[]>`
          select (
            to_regclass('public.jobs') is not null
            and to_regclass('public.runs') is not null
            and to_regclass('public.job_events') is not null
            and to_regclass('public.outbox_events') is not null
            and to_regclass('public.run_effects') is not null
            and to_regclass('public.trace_spans') is not null
            and to_regclass('public.checkpoint_attempts') is not null
            and to_regclass('public.job_interrupts') is not null
            and to_regclass('public.job_commands') is not null
            and to_regclass('public.articles') is not null
            and to_regclass('langgraph_checkpoint.checkpoint_migrations') is not null
            and to_regclass('langgraph_checkpoint.checkpoints') is not null
            and to_regclass('langgraph_checkpoint.checkpoint_blobs') is not null
            and to_regclass('langgraph_checkpoint.checkpoint_writes') is not null
          ) as ready
        `
        if (consumerSchema?.ready !== true) {
          throw new Error('Write consumer database schema is incomplete')
        }
      }
    },
    ...(saver ? {
      closeCheckpoint: () => saver.end(),
    } : {}),
    ...(publisher ? {
      startPublisher: async () => { await publisher.waitUntilReady() },
      closePublisher: () => publisher.close(),
    } : {}),
    ...(consumer ? {
      startConsumer: () => consumer.start(),
      closeConsumer: () => consumer.close(false),
    } : {}),
    ...(dispatcher ? { dispatchBatch: () => dispatcher.dispatchBatch() } : {}),
    closeDatabase: async () => {
      await Promise.all([
        dispatcherDatabase?.close(),
        consumerDatabase?.close(),
      ])
    },
    onDispatcherError: (error) => report('outbox.dispatch', error),
  }, config.dispatchPollMs)
}

export async function runProductionWorker(env: NodeJS.ProcessEnv = process.env) {
  const runtime = createProductionWorkerRuntime(loadProductionWorkerConfig(env))
  try {
    await runtime.start()
  } catch (error) {
    await runtime.close()
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void runtime.close().then(resolve, reject)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
