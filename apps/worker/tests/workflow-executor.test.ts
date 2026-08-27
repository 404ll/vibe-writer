import { MemorySaver } from '@langchain/langgraph'
import { WORKFLOW_VERSION, type WorkflowServices } from '@vibe-writer/workflow-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  DurableWorkflowExecutor,
  type WorkerExecutionContext,
  type WorkflowCheckpointFactory,
} from '../src'

function services(overrides: Partial<WorkflowServices> = {}): WorkflowServices {
  return {
    plan: vi.fn(async () => ['第一章']),
    reviseOutline: vi.fn(async ({ outline }) => outline),
    planCoverage: vi.fn(async ({ chapterTitle }) => ({
      status: 'ready' as const,
      points: [{ text: `覆盖 ${chapterTitle}`, searchQuery: `${chapterTitle} 查询` }],
    })),
    writeChapter: vi.fn(async ({ chapterTitle, budgetUsage }) => ({
      status: 'ready' as const,
      content: `${chapterTitle}正文`,
      executions: [],
      modelCalls: [],
      budgetUsage,
      modelRequests: 1,
      toolRounds: 0,
    })),
    reviewChapter: vi.fn(async () => ({
      verdict: 'passed' as const,
      feedback: '',
      source: 'model' as const,
    })),
    reviewFull: vi.fn(async ({ chapters }) =>
      chapters.map(() => ({
        verdict: 'passed' as const,
        feedback: '',
        source: 'model' as const,
      }))),
    ...overrides,
  }
}

function context(overrides: Partial<WorkerExecutionContext> = {}): WorkerExecutionContext {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    leaseToken: 'lease-1',
    job: {
      id: '11111111-1111-4111-8111-111111111111',
      topic: 'Durable workflow',
      style: '',
      targetWords: null,
      intervention: { on_outline: false },
    },
    run: {
      id: '22222222-2222-4222-8222-222222222222',
      modelProfile: {
        profile: 'scripted',
        provider: 'scripted',
        model: 'scripted-v1',
      },
      promptVersion: 'prompt-v1',
      graphVersion: WORKFLOW_VERSION,
      toolVersions: { writer: 'writer-v1' },
      codeRevision: 'test-revision',
    },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function memoryFactory(
  checkpointer: MemorySaver,
  resumeFromCheckpoint: () => boolean = () => false,
): WorkflowCheckpointFactory {
  return async () => ({
    checkpointer,
    config: { configurable: { thread_id: 'durable-workflow-test' } },
    resumeFromCheckpoint: resumeFromCheckpoint(),
  })
}

describe('DurableWorkflowExecutor', () => {
  it('returns a schema-valid export intent without committing infrastructure state', async () => {
    const result = await new DurableWorkflowExecutor(
      services(),
      memoryFactory(new MemorySaver()),
    ).execute(context())

    expect(result).toEqual({
      status: 'completed',
      exportIntent: {
        idempotencyKey:
          'job:11111111-1111-4111-8111-111111111111:article:export',
        markdown: '# Durable workflow\n\n## 第一章\n第一章正文',
      },
    })
  })

  it('persists workflow progress with the active lease identity', async () => {
    const appendRunEvent = vi.fn(async (input) => ({
      status: 'appended' as const,
      event: input.event,
    }))
    const result = await new DurableWorkflowExecutor(
      services(),
      memoryFactory(new MemorySaver()),
      undefined,
      { appendRunEvent },
    ).execute(context())

    expect(result.status).toBe('completed')
    expect(appendRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: context().jobId,
        runId: context().runId,
        leaseToken: context().leaseToken,
        idempotencyKey: 'workflow:stage:plan',
        event: { event: 'stage_update', data: { stage: 'plan' } },
      }),
    )
    expect(appendRunEvent.mock.calls.map(([input]) => input.event.event)).toContain(
      'chapter_done',
    )
  })

  it('stops before provider work when progress persistence loses the lease', async () => {
    const workflowServices = services()
    const executor = new DurableWorkflowExecutor(
      workflowServices,
      memoryFactory(new MemorySaver()),
      undefined,
      {
        appendRunEvent: vi.fn(async () => ({ status: 'lease_lost' as const })),
      },
    )

    await expect(executor.execute(context())).rejects.toMatchObject({
      name: 'AbortError',
      code: 'cancelled',
    })
    expect(workflowServices.plan).not.toHaveBeenCalled()
  })

  it('maps an outline interrupt to awaiting_input', async () => {
    const result = await new DurableWorkflowExecutor(
      services(),
      memoryFactory(new MemorySaver()),
    ).execute(
      context({
        job: {
          ...context().job,
          intervention: { on_outline: true },
        },
      }),
    )

    expect(result).toMatchObject({
      status: 'awaiting_input',
      interruptId: expect.any(String),
      outline: ['第一章'],
    })
  })

  it('applies a durable reply only when the restored checkpoint is interrupted', async () => {
    const checkpointer = new MemorySaver()
    let resume = false
    const workflowServices = services()
    const factory = memoryFactory(checkpointer, () => resume)
    const first = await new DurableWorkflowExecutor(
      workflowServices,
      factory,
    ).execute(
      context({
        job: { ...context().job, intervention: { on_outline: true } },
      }),
    )
    if (first.status !== 'awaiting_input') throw new Error('Expected interrupt')

    resume = true
    const commands = {
      getOutlineReply: vi.fn(async (_jobId: string, interruptId: string) =>
        interruptId === first.interruptId
          ? { message: '确认', outline: ['第一章'] }
          : null,
      ),
    }
    const completed = await new DurableWorkflowExecutor(
      workflowServices,
      factory,
      commands,
    ).execute(
      context({
        runId: '33333333-3333-4333-8333-333333333333',
        job: { ...context().job, intervention: { on_outline: true } },
        run: {
          ...context().run,
          id: '33333333-3333-4333-8333-333333333333',
        },
      }),
    )

    expect(completed.status).toBe('completed')
    expect(commands.getOutlineReply).toHaveBeenCalledWith(
      context().jobId,
      first.interruptId,
    )
    expect(workflowServices.plan).toHaveBeenCalledTimes(1)
  })

  it('replays a terminal checkpoint without repeating workflow services', async () => {
    const checkpointer = new MemorySaver()
    let resume = false
    const workflowServices = services()
    const executor = new DurableWorkflowExecutor(
      workflowServices,
      memoryFactory(checkpointer, () => resume),
    )

    const first = await executor.execute(context())
    resume = true
    const replay = await executor.execute(
      context({
        runId: '33333333-3333-4333-8333-333333333333',
        run: {
          ...context().run,
          id: '33333333-3333-4333-8333-333333333333',
        },
      }),
    )

    expect(replay).toEqual(first)
    expect(workflowServices.plan).toHaveBeenCalledTimes(1)
    expect(workflowServices.writeChapter).toHaveBeenCalledTimes(1)
  })

  it('returns a sanitized structured failure when the graph fails', async () => {
    const result = await new DurableWorkflowExecutor(
      services({
        plan: vi.fn(async () => {
          throw new Error('provider secret')
        }),
      }),
      memoryFactory(new MemorySaver()),
    ).execute(context())

    expect(result).toEqual({
      status: 'failed',
      errorCode: 'workflow_service_exception',
      errorMessage: 'Workflow failed during plan.',
    })
  })
})
