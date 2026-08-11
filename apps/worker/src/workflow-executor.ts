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
  type WorkflowServices,
} from '@vibe-writer/workflow-runtime'
import type { ReplyRequest } from '@vibe-writer/contracts/jobs'
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

export type WorkflowServicesFactory = (
  context: WorkerExecutionContext,
) => WorkflowServices

export function createFencedWorkflowCheckpointFactory(
  saver: BaseCheckpointSaver,
  control: CheckpointAttemptControl,
): WorkflowCheckpointFactory {
  return async (context) => {
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
  ) {}

  async execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    if (context.signal.aborted) throw new DOMException('Operation aborted.', 'AbortError')
    const session = await this.checkpoints(context)
    const services =
      typeof this.services === 'function'
        ? this.services(context)
        : this.services
    const graph = buildWorkflowGraph(services, {
      checkpointer: session.checkpointer,
      signal: context.signal,
    })
    const config = { ...session.config, signal: context.signal }
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
