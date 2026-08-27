import type { RunnableConfig } from '@langchain/core/runnables'
import {
  isInterrupted,
  type BaseCheckpointSaver,
} from '@langchain/langgraph'
import {
  initializeCheckpointAttempt,
  type CheckpointAttemptControl,
} from '@vibe-writer/checkpoint-runtime'
import {
  buildWorkflowGraph,
  createWorkflowState,
  resumeOutline,
  WorkflowStateSchema,
  type WorkflowProgressEvent,
  type WorkflowServices,
} from '@vibe-writer/workflow-runtime'
import type { ReplyRequest } from '@vibe-writer/contracts/jobs'
import type {
  AppendRunEventInput,
  AppendRunEventResult,
} from '@vibe-writer/db'
import type {
  WorkerExecutionContext,
  WorkerExecutionResult,
  WorkerExecutor,
} from './runner'

export type WorkflowCheckpointSession = {
  checkpointer: BaseCheckpointSaver
  config: RunnableConfig
  resumeFromCheckpoint: boolean
}

export type WorkflowCheckpointFactory = (
  context: WorkerExecutionContext,
) => Promise<WorkflowCheckpointSession>

export type WorkflowCommandSource = {
  getOutlineReply(jobId: string, interruptId: string): Promise<ReplyRequest | null>
}

export type WorkflowEventControl = {
  appendRunEvent(input: AppendRunEventInput): Promise<AppendRunEventResult>
}

export type WorkflowServicesFactory = (
  context: WorkerExecutionContext,
) => WorkflowServices

class WorkflowProgressProjectionError extends Error {
  readonly name = 'AbortError'
  readonly code = 'cancelled'
}

export function createFencedWorkflowCheckpointFactory(
  saver: BaseCheckpointSaver,
  control: CheckpointAttemptControl,
): WorkflowCheckpointFactory {
  return async (context) => {
    // 每次 Worker 领取任务都会准备独立 attempt，并用 runId + leaseToken
    // 约束 Checkpoint 写入；旧 Worker 失去租约后不能覆盖新进度。
    const checkpointer = await initializeCheckpointAttempt(saver, control, context)
    return {
      checkpointer,
      config: checkpointer.config(),
      resumeFromCheckpoint: checkpointer.attempt.latestCheckpointId !== null,
    }
  }
}

function toolsetVersion(toolVersions: Record<string, string>): string {
  const version = Object.entries(toolVersions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}@${value}`)
    .join(',')
  if (!version) throw new Error('Run toolVersions cannot be empty')
  return version
}

function interruptOutline(
  interrupt: { id?: string; value?: unknown } | undefined,
): { interruptId: string; outline: string[] } | null {
  const value = interrupt?.value
  if (!interrupt?.id?.trim()) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type !== 'outline_review' || !Array.isArray(record.outline)) return null
  const outline = record.outline.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )
  return outline.length === record.outline.length && outline.length > 0
    ? { interruptId: interrupt.id, outline }
    : null
}

export class DurableWorkflowExecutor implements WorkerExecutor {
  constructor(
    private readonly services: WorkflowServices | WorkflowServicesFactory,
    private readonly checkpoints: WorkflowCheckpointFactory,
    private readonly commands?: WorkflowCommandSource,
    private readonly events?: WorkflowEventControl,
  ) {}

  async execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    if (context.signal.aborted) throw new DOMException('Operation aborted.', 'AbortError')
    const session = await this.checkpoints(context)
    const services =
      typeof this.services === 'function'
        ? this.services(context)
        : this.services
    const persistProgress = this.events
      ? async (progress: WorkflowProgressEvent) => {
          let result: AppendRunEventResult
          try {
            result = await this.events!.appendRunEvent({
              jobId: context.jobId,
              runId: context.runId,
              leaseToken: context.leaseToken,
              idempotencyKey: progress.idempotencyKey,
              event: progress.event,
            })
          } catch (error) {
            throw new WorkflowProgressProjectionError(
              'Durable workflow progress could not be persisted.',
              { cause: error },
            )
          }
          if (result.status === 'appended' || result.status === 'replayed') return
          // 进度事件与模型调用使用同一租约边界。取消或 lease 丢失后立刻中止
          // Graph，旧 Worker 不能继续调用供应商或向新 attempt 的事件流写数据。
          throw new WorkflowProgressProjectionError(
            `Durable workflow progress lost its owner: ${result.status}`,
          )
        }
      : undefined
    const graph = buildWorkflowGraph(services, {
      checkpointer: session.checkpointer,
      signal: context.signal,
      ...(persistProgress ? { progress: persistProgress } : {}),
    })
    const config = { ...session.config, signal: context.signal }
    // 接管或重试必须重放已提交的 LangGraph 检查点，而不是从头调用模型。
    // 新任务则把本次运行绑定的状态图、提示词、模型、工具和代码版本写进初始状态。
    let rawResult = session.resumeFromCheckpoint
      ? await graph.replay(config)
      : await graph.invoke(
          createWorkflowState({
            jobId: context.job.id,
            topic: context.job.topic,
            style: context.job.style,
            ...(context.job.targetWords
              ? { targetWords: context.job.targetWords }
              : {}),
            interventionOnOutline: context.job.intervention.on_outline,
            executionConfig: {
              id: context.run.id,
              graphVersion: context.run.graphVersion,
              promptSetVersion: context.run.promptVersion,
              modelProfileId: context.run.modelProfile.profile,
              toolsetVersion: toolsetVersion(context.run.toolVersions),
              codeRevision: context.run.codeRevision,
            },
          }),
          config,
        )
    if (
      session.resumeFromCheckpoint &&
      this.commands &&
      isInterrupted(rawResult)
    ) {
      // replay 先恢复到稳定的 interrupt，再按 interruptId 读取持久化回复。
      // 只有匹配当前 interrupt 的 command 才能继续流程，旧回复不会误用到新暂停点。
      const pending = interruptOutline(rawResult.__interrupt__[0])
      if (pending) {
        const reply = await this.commands.getOutlineReply(
          context.jobId,
          pending.interruptId,
        )
        if (reply) rawResult = await graph.invoke(resumeOutline(reply), config)
      }
    }
    if (context.signal.aborted) throw new DOMException('Operation aborted.', 'AbortError')

    if (isInterrupted(rawResult)) {
      // 没有回复时把中断投影成业务层 awaiting_input。真正的 Job 状态、
      // interrupt 记录和 outline_ready 事件由 Runner 后续在同一事务提交。
      const pending = interruptOutline(rawResult.__interrupt__[0])
      return pending
        ? { status: 'awaiting_input', ...pending }
        : {
            status: 'failed',
            errorCode: 'invalid_workflow_interrupt',
            errorMessage: 'Workflow produced an unsupported interrupt.',
          }
    }

    const parsed = WorkflowStateSchema.safeParse(rawResult)
    if (!parsed.success) {
      return {
        status: 'failed',
        errorCode: 'invalid_workflow_state',
        errorMessage: 'Workflow returned an invalid terminal state.',
      }
    }
    if (parsed.data.phase === 'failed') {
      return {
        status: 'failed',
        errorCode: `workflow_${parsed.data.failure!.code}`,
        errorMessage: `Workflow failed during ${parsed.data.failure!.stage}.`,
      }
    }
    if (parsed.data.phase !== 'completed' || !parsed.data.exportIntent) {
      return {
        status: 'failed',
        errorCode: 'non_terminal_workflow_state',
        errorMessage: 'Workflow stopped without a durable outcome.',
      }
    }
    return {
      status: 'completed',
      exportIntent: parsed.data.exportIntent,
    }
  }
}
