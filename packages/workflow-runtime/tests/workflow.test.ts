import { readFileSync } from 'node:fs'
import { Command, MemorySaver, isInterrupted } from '@langchain/langgraph'
import type {
  CoveragePlanResult,
  ReviewResult,
  ToolBudgetUsage,
  WriterResult,
} from '@vibe-writer/agent-core'
import { WorkflowComponentFixtureSchema } from '@vibe-writer/contracts/workflow-component-fixtures'
import { describe, expect, it, vi } from 'vitest'
import {
  buildWorkflowGraph,
  createChapterState,
  createWorkflowState,
  fullReviewDecision,
  resumeOutline,
  WorkflowStateSchema,
  writerInconclusiveDecision,
  type WorkflowServices,
} from '../src'

const fixture = WorkflowComponentFixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../contracts/fixtures/workflow-control-baseline.json', import.meta.url),
      'utf8',
    ),
  ),
)

function budget(totalCalls = 0, searchCalls = 0): ToolBudgetUsage {
  return {
    totalCalls,
    callsByTool: searchCalls ? { search: searchCalls } : {},
  }
}

function readyWriter(content: string, usage = budget()): WriterResult {
  return {
    status: 'ready',
    content,
    executions: [],
    modelCalls: [],
    budgetUsage: usage,
    modelRequests: 1,
    toolRounds: 0,
  }
}

function inconclusiveWriter(
  reason: Extract<WriterResult, { status: 'inconclusive' }>['reason'],
  usage = budget(),
): WriterResult {
  return {
    status: 'inconclusive',
    reason,
    partialContent: '',
    executions: [],
    modelCalls: [],
    budgetUsage: usage,
    modelRequests: 1,
    toolRounds: 0,
  }
}

function review(verdict: ReviewResult['verdict'], feedback = ''): ReviewResult {
  return { verdict, feedback, source: 'model' }
}

function readyCoverage(title: string): CoveragePlanResult {
  return {
    status: 'ready',
    points: [{ text: `覆盖 ${title}`, searchQuery: `${title} 查询` }],
  }
}

function scriptedServices(overrides: Partial<WorkflowServices> = {}): WorkflowServices {
  return {
    plan: vi.fn(async () => ['第一章']),
    reviseOutline: vi.fn(async ({ outline }) => outline),
    planCoverage: vi.fn(async ({ chapterTitle }) => readyCoverage(chapterTitle)),
    writeChapter: vi.fn(async ({ chapterTitle, budgetUsage }) =>
      readyWriter(`${chapterTitle}正文`, budgetUsage),
    ),
    reviewChapter: vi.fn(async () => review('passed')),
    reviewFull: vi.fn(async ({ chapters }) => chapters.map(() => review('passed'))),
    ...overrides,
  }
}

function interruptValues(result: unknown): Array<{ value: unknown }> {
  expect(isInterrupted(result)).toBe(true)
  return (result as { __interrupt__: Array<{ value: unknown }> }).__interrupt__
}

describe('workflow state and policy', () => {
  it.each(fixture.rewrite_route_cases)('maps rewrite route case $id', (testCase) => {
    expect(
      fullReviewDecision(
        testCase.chapter_passed.filter((passed) => !passed).length,
        testCase.review_count,
      ),
    ).toBe(testCase.target_route)
  })

  it.each(fixture.writer_policy_cases)('maps Writer policy case $id', (testCase) => {
    expect(writerInconclusiveDecision(testCase.reason, testCase.attempts)).toBe(
      testCase.target,
    )
  })

  it('creates a JSON-serializable, schema-valid initial state', () => {
    const state = createWorkflowState({ jobId: 'job-1', topic: '可恢复写作' })
    expect(WorkflowStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it('only retries selected Writer reasons once', () => {
    expect(writerInconclusiveDecision('empty_final_text', 1)).toBe('retry')
    expect(writerInconclusiveDecision('empty_final_text', 2)).toBe('terminal')
    expect(writerInconclusiveDecision('refusal', 1)).toBe('terminal')
    expect(writerInconclusiveDecision('max_tool_rounds', 1)).toBe('terminal')
  })

  it('propagates runtime cancellation and article style to every service boundary', async () => {
    const controller = new AbortController()
    const services = scriptedServices()
    const graph = buildWorkflowGraph(services, { signal: controller.signal })
    await graph.invoke(createWorkflowState({
      jobId: 'job-runtime-context', topic: '上下文传播', style: '教程',
      interventionOnOutline: false,
    }))
    for (const service of [
      services.plan, services.planCoverage, services.writeChapter,
      services.reviewChapter, services.reviewFull,
    ]) {
      expect(service).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    }
    expect(services.writeChapter).toHaveBeenCalledWith(expect.objectContaining({ style: '教程' }))
  })

  it('rejects semantically invalid terminal states and tool budgets', () => {
    const initial = createWorkflowState({ jobId: 'job-invalid-state', topic: '状态' })
    expect(
      WorkflowStateSchema.safeParse({ ...initial, phase: 'completed' }).success,
    ).toBe(false)
    expect(WorkflowStateSchema.safeParse({ ...initial, phase: 'failed' }).success).toBe(
      false,
    )
    expect(
      WorkflowStateSchema.safeParse({
        ...initial,
        chapters: [
          {
            ...createChapterState('非法预算'),
            title: '非法预算',
            toolBudgetUsage: { totalCalls: 1, callsByTool: { search: 2 } },
          },
        ],
      }).success,
    ).toBe(false)

    const completed = {
      ...initial,
      phase: 'completed' as const,
      finalContent: '# 完成',
      exportIntent: { idempotencyKey: 'job:key', markdown: '# 完成' },
    }
    expect(WorkflowStateSchema.safeParse(completed).success).toBe(true)
  })
})

describe('LangGraph workflow adapter', () => {
  it('requires a checkpointer when outline intervention is enabled', async () => {
    const graph = buildWorkflowGraph(scriptedServices())
    await expect(
      graph.invoke(createWorkflowState({ jobId: 'job-no-saver', topic: '主题' })),
    ).rejects.toThrow('Outline intervention requires a checkpointer')
  })

  it('runs the deterministic happy path and returns an export intent without side effects', async () => {
    const services = scriptedServices()
    const graph = buildWorkflowGraph(services)
    const result = await graph.invoke(
      createWorkflowState({
        jobId: 'job-happy',
        topic: '可恢复写作',
        interventionOnOutline: false,
      }),
    )

    expect(result.phase).toBe('completed')
    expect(result.finalContent).toBe('# 可恢复写作\n\n## 第一章\n第一章正文')
    expect(result.exportIntent).toEqual({
      idempotencyKey: 'job:job-happy:article:export',
      markdown: result.finalContent,
    })
    expect(result.failure).toBeNull()
    expect(
      WorkflowStateSchema.parse(JSON.parse(JSON.stringify(result))),
    ).toEqual(result)
  })

  it('completes the maximum six-chapter outline without caller recursion tuning', async () => {
    const services = scriptedServices({
      plan: vi.fn(async () => ['一', '二', '三', '四', '五', '六']),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-six-chapters',
        topic: '长文',
        interventionOnOutline: false,
      }),
    )
    expect(result.phase).toBe('completed')
    expect(result.chapters).toHaveLength(6)
  })

  it('interrupts for outline review, revises once, and resumes without repeating plan or revise', async () => {
    const services = scriptedServices({
      plan: vi.fn(async () => ['旧大纲']),
      reviseOutline: vi.fn(async ({ outline, feedback }) => [
        `${outline[0]}-${feedback}`,
      ]),
    })
    const checkpointer = new MemorySaver()
    let graph = buildWorkflowGraph(services, { checkpointer })
    const config = { configurable: { thread_id: 'thread-outline' } }

    const first = await graph.invoke(
      createWorkflowState({ jobId: 'job-outline', topic: '主题' }),
      config,
    )
    expect(interruptValues(first)[0]?.value).toEqual({
      type: 'outline_review',
      outline: ['旧大纲'],
    })

    graph = buildWorkflowGraph(services, { checkpointer })
    const second = await graph.invoke(
      resumeOutline({ message: '补充案例', outline: ['编辑稿'] }),
      config,
    )
    expect(interruptValues(second)[0]?.value).toEqual({
      type: 'outline_review',
      outline: ['编辑稿-补充案例'],
    })

    graph = buildWorkflowGraph(services, { checkpointer })
    const final = await graph.invoke(resumeOutline({ message: '确认' }), config)
    expect(final.phase).toBe('completed')
    expect(final.outline).toEqual(['编辑稿-补充案例'])
    expect(services.plan).toHaveBeenCalledTimes(1)
    expect(services.reviseOutline).toHaveBeenCalledTimes(1)
  })

  it('accepts an explicit confirmation and a legacy null outline without revising', async () => {
    const services = scriptedServices({ plan: vi.fn(async () => ['直接确认']) })
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'thread-confirm' } }
    let graph = buildWorkflowGraph(services, { checkpointer })

    interruptValues(
      await graph.invoke(
        createWorkflowState({ jobId: 'job-confirm', topic: '主题' }),
        config,
      ),
    )
    graph = buildWorkflowGraph(services, { checkpointer })
    const result = await graph.invoke(
      resumeOutline({ message: '确认', outline: null }),
      config,
    )

    expect(result.phase).toBe('completed')
    expect(services.reviseOutline).not.toHaveBeenCalled()
  })

  it('treats an edited outline with no message as an explicit confirmation', async () => {
    const services = scriptedServices()
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'thread-edit-confirm' } }
    const graph = buildWorkflowGraph(services, { checkpointer })
    interruptValues(
      await graph.invoke(
        createWorkflowState({ jobId: 'job-edit-confirm', topic: '主题' }),
        config,
      ),
    )

    const result = await graph.invoke(
      resumeOutline({ message: '', outline: ['编辑后大纲'] }),
      config,
    )
    expect(result.phase).toBe('completed')
    expect(result.outline).toEqual(['编辑后大纲'])
    expect(services.reviseOutline).not.toHaveBeenCalled()
  })

  it('fails the workflow when a resumed outline command is invalid', async () => {
    const services = scriptedServices()
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'thread-invalid-resume' } }
    const graph = buildWorkflowGraph(services, { checkpointer })
    interruptValues(
      await graph.invoke(
        createWorkflowState({ jobId: 'job-invalid-resume', topic: '主题' }),
        config,
      ),
    )

    const result = await graph.invoke(
      new Command({ resume: {} }) as Parameters<typeof graph.invoke>[0],
      config,
    )
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'outline_review', code: 'invalid_outline_reply' },
    })
  })

  it('isolates outline interrupts by thread id in one MemorySaver', async () => {
    const services = scriptedServices({
      plan: vi.fn(async ({ topic }) => [`${topic}大纲`]),
    })
    const checkpointer = new MemorySaver()
    const graph = buildWorkflowGraph(services, { checkpointer })
    const firstConfig = { configurable: { thread_id: 'thread-isolated-a' } }
    const secondConfig = { configurable: { thread_id: 'thread-isolated-b' } }

    interruptValues(
      await graph.invoke(
        createWorkflowState({ jobId: 'job-isolated-a', topic: '甲' }),
        firstConfig,
      ),
    )
    interruptValues(
      await graph.invoke(
        createWorkflowState({ jobId: 'job-isolated-b', topic: '乙' }),
        secondConfig,
      ),
    )
    const first = await graph.invoke(resumeOutline({ action: 'confirm' }), firstConfig)
    const second = await graph.getState(secondConfig)

    expect(first).toMatchObject({ phase: 'completed', jobId: 'job-isolated-a' })
    expect(second.values).toMatchObject({
      phase: 'plan',
      jobId: 'job-isolated-b',
      outline: ['乙大纲'],
    })
    expect(second.next).toEqual(['outline_review'])
  })

  it('replays from the first completed chapter without repeating that chapter', async () => {
    const coverageCalls: string[] = []
    const writeCalls: string[] = []
    const lightReviewCalls: string[] = []
    const services = scriptedServices({
      plan: vi.fn(async () => ['甲', '乙']),
      planCoverage: vi.fn(async ({ chapterTitle }) => {
        coverageCalls.push(chapterTitle)
        return readyCoverage(chapterTitle)
      }),
      writeChapter: vi.fn(async ({ chapterTitle, budgetUsage }) => {
        writeCalls.push(chapterTitle)
        return readyWriter(`${chapterTitle}正文`, {
          totalCalls: budgetUsage.totalCalls + 1,
          callsByTool: { search: (budgetUsage.callsByTool.search ?? 0) + 1 },
        })
      }),
      reviewChapter: vi.fn(async ({ chapterTitle }) => {
        lightReviewCalls.push(chapterTitle)
        return review('passed')
      }),
    })
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'thread-chapter-replay' } }
    let graph = buildWorkflowGraph(services, { checkpointer })
    await graph.invoke(
      createWorkflowState({
        jobId: 'job-chapter-replay',
        topic: '回放',
        interventionOnOutline: false,
      }),
      config,
    )

    const history: Array<Awaited<ReturnType<typeof graph.getState>>> = []
    for await (const snapshot of graph.getStateHistory(config)) history.push(snapshot)
    const terminalCheckpoint = history.find((snapshot) => snapshot.next.length === 0)
    expect(terminalCheckpoint).toBeDefined()
    const callsBeforeTerminalReplay = {
      coverage: coverageCalls.length,
      write: writeCalls.length,
      review: lightReviewCalls.length,
    }
    graph = buildWorkflowGraph(services, { checkpointer })
    const terminalReplay = await graph.replay(terminalCheckpoint!.config)
    expect(terminalReplay.phase).toBe('completed')
    expect({
      coverage: coverageCalls.length,
      write: writeCalls.length,
      review: lightReviewCalls.length,
    }).toEqual(callsBeforeTerminalReplay)

    const checkpoint = history.find(
      (snapshot) =>
        snapshot.values.currentChapterIndex === 1 &&
        snapshot.next.includes('coverage'),
    )
    expect(checkpoint).toBeDefined()
    const restored = WorkflowStateSchema.parse(
      JSON.parse(JSON.stringify(checkpoint!.values)),
    )
    expect(restored.chapters[0]).toMatchObject({
      title: '甲',
      lightReviewStatus: 'passed',
      toolBudgetUsage: budget(1, 1),
    })

    graph = buildWorkflowGraph(services, { checkpointer })
    const replayed = await graph.replay(checkpoint!.config)
    expect(replayed.phase).toBe('completed')
    expect(coverageCalls.filter((title) => title === '甲')).toHaveLength(1)
    expect(writeCalls.filter((title) => title === '甲')).toHaveLength(1)
    expect(lightReviewCalls.filter((title) => title === '甲')).toHaveLength(1)
    expect(coverageCalls.filter((title) => title === '乙')).toHaveLength(2)
  })

  it('persists Writer tool budget across a light-review rewrite', async () => {
    const seenBudgets: ToolBudgetUsage[] = []
    const services = scriptedServices({
      writeChapter: vi
        .fn<WorkflowServices['writeChapter']>()
        .mockImplementationOnce(async (input) => {
          seenBudgets.push(input.budgetUsage)
          return readyWriter('初稿', budget(3, 3))
        })
        .mockImplementationOnce(async (input) => {
          seenBudgets.push(input.budgetUsage)
          return readyWriter('重写稿', budget(4, 3))
        }),
      reviewChapter: vi
        .fn<WorkflowServices['reviewChapter']>()
        .mockResolvedValueOnce(review('failed', '补充证据'))
        .mockResolvedValueOnce(review('passed')),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-budget',
        topic: '预算',
        interventionOnOutline: false,
      }),
    )

    expect(seenBudgets).toEqual([budget(), budget(3, 3)])
    expect(result.chapters[0]).toMatchObject({
      content: '重写稿',
      lightRewriteCount: 1,
      toolBudgetUsage: budget(4, 3),
    })
  })

  it('retries a retryable Writer inconclusive once and then fails explicitly', async () => {
    const services = scriptedServices({
      writeChapter: vi.fn(async () => inconclusiveWriter('empty_final_text')),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-writer-failed',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )

    expect(services.writeChapter).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'write', code: 'empty_final_text', retryable: false },
    })
    expect(WorkflowStateSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result)
  })

  it.each(['refusal', 'max_tool_rounds'] as const)(
    'treats Writer %s as immediately terminal in the full graph',
    async (reason) => {
      const services = scriptedServices({
        writeChapter: vi.fn(async () => inconclusiveWriter(reason)),
      })
      const result = await buildWorkflowGraph(services).invoke(
        createWorkflowState({
          jobId: `job-writer-${reason}`,
          topic: '失败',
          interventionOnOutline: false,
        }),
      )
      expect(services.writeChapter).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        phase: 'failed',
        failure: { stage: 'write', code: reason },
      })
    },
  )

  it('does not rerun a failed terminal checkpoint', async () => {
    const services = scriptedServices({
      writeChapter: vi.fn(async () => inconclusiveWriter('refusal')),
    })
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'thread-failed-terminal' } }
    let graph = buildWorkflowGraph(services, { checkpointer })
    const failed = await graph.invoke(
      createWorkflowState({
        jobId: 'job-failed-terminal',
        topic: '失败',
        interventionOnOutline: false,
      }),
      config,
    )
    expect(WorkflowStateSchema.parse(JSON.parse(JSON.stringify(failed)))).toEqual(failed)
    const terminal = await graph.getState(config)
    expect(terminal.next).toEqual([])

    graph = buildWorkflowGraph(services, { checkpointer })
    const replayed = await graph.replay(terminal.config)
    expect(replayed.phase).toBe('failed')
    expect(services.writeChapter).toHaveBeenCalledTimes(1)
  })

  it('counts Writer service exceptions against the two-attempt domain budget', async () => {
    const services = scriptedServices({
      writeChapter: vi.fn(async () => {
        throw new Error('provider timeout')
      }),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-writer-exception',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )
    expect(services.writeChapter).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'write', code: 'service_exception' },
    })
  })

  it('fails explicitly after Planner returns an empty outline twice', async () => {
    const services = scriptedServices({ plan: vi.fn(async () => []) })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-plan-failed',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )

    expect(services.plan).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'plan', code: 'empty_outline', retryable: false },
    })
  })

  it('counts Planner service exceptions against the two-attempt domain budget', async () => {
    const services = scriptedServices({
      plan: vi.fn(async () => {
        throw new Error('provider timeout')
      }),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-plan-exception',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )
    expect(services.plan).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      outlineAttempts: 2,
      failure: { stage: 'plan', code: 'service_exception' },
    })
  })

  it('retries an empty revised outline once and then fails explicitly', async () => {
    const services = scriptedServices({ reviseOutline: vi.fn(async () => []) })
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'thread-empty-revision' } }
    const graph = buildWorkflowGraph(services, { checkpointer })
    interruptValues(
      await graph.invoke(
        createWorkflowState({ jobId: 'job-empty-revision', topic: '主题' }),
        config,
      ),
    )
    const result = await graph.invoke(
      resumeOutline({ action: 'revise', message: '请修改' }),
      config,
    )
    expect(services.reviseOutline).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      outlineRevisionAttempts: 2,
      failure: { stage: 'outline_review', code: 'empty_revised_outline' },
    })
  })

  it('counts outline-revision service exceptions against the two-attempt domain budget', async () => {
    const services = scriptedServices({
      reviseOutline: vi.fn(async () => {
        throw new Error('provider timeout')
      }),
    })
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'thread-revision-exception' } }
    const graph = buildWorkflowGraph(services, { checkpointer })
    interruptValues(
      await graph.invoke(
        createWorkflowState({ jobId: 'job-revision-exception', topic: '主题' }),
        config,
      ),
    )
    const result = await graph.invoke(
      resumeOutline({ action: 'revise', message: '请修改' }),
      config,
    )
    expect(services.reviseOutline).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      outlineRevisionAttempts: 2,
      failure: { stage: 'outline_review', code: 'service_exception' },
    })
  })

  it('fails explicitly after Coverage remains inconclusive twice', async () => {
    const services = scriptedServices({
      planCoverage: vi.fn<WorkflowServices['planCoverage']>(async () => ({
        status: 'inconclusive',
        points: [],
        reason: 'invalid_model_output',
      })),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-coverage-failed',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )

    expect(services.planCoverage).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'coverage', code: 'invalid_model_output' },
    })
  })

  it('normalizes ready-empty Coverage output and service exceptions into bounded failure', async () => {
    const emptyServices = scriptedServices({
      planCoverage: vi.fn(async () => ({ status: 'ready' as const, points: [] })),
    })
    const emptyResult = await buildWorkflowGraph(emptyServices).invoke(
      createWorkflowState({
        jobId: 'job-coverage-empty',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )
    expect(emptyServices.planCoverage).toHaveBeenCalledTimes(2)
    expect(emptyResult).toMatchObject({
      phase: 'failed',
      failure: { stage: 'coverage', code: 'service_exception' },
    })

    const throwingServices = scriptedServices({
      planCoverage: vi.fn(async () => {
        throw new Error('provider timeout')
      }),
    })
    const throwingResult = await buildWorkflowGraph(throwingServices).invoke(
      createWorkflowState({
        jobId: 'job-coverage-exception',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )
    expect(throwingServices.planCoverage).toHaveBeenCalledTimes(2)
    expect(throwingResult).toMatchObject({
      phase: 'failed',
      failure: { stage: 'coverage', code: 'service_exception' },
    })
  })

  it('fails explicitly after chapter review remains inconclusive twice', async () => {
    const services = scriptedServices({
      reviewChapter: vi.fn<WorkflowServices['reviewChapter']>(async () => ({
        ...review('inconclusive'),
        reason: 'invalid_model_output' as const,
      })),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-light-review-failed',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )

    expect(services.reviewChapter).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'review', code: 'invalid_model_output' },
    })
  })

  it('records a warning when a light-review rewrite still fails', async () => {
    const services = scriptedServices({
      reviewChapter: vi
        .fn<WorkflowServices['reviewChapter']>()
        .mockResolvedValueOnce(review('failed', '第一次失败'))
        .mockResolvedValueOnce(review('failed', '第二次失败')),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-light-review-warning',
        topic: '轻审',
        interventionOnOutline: false,
      }),
    )
    expect(result.phase).toBe('completed')
    expect(result.chapters[0]).toMatchObject({
      lightRewriteCount: 1,
      lightReviewStatus: 'failed',
    })
    expect(result.qualityWarnings).toContain('轻审未通过：第一章：第二次失败')
  })

  it('counts chapter-review service exceptions against the two-attempt domain budget', async () => {
    const services = scriptedServices({
      reviewChapter: vi.fn(async () => {
        throw new Error('provider timeout')
      }),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-review-exception',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )
    expect(services.reviewChapter).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'review', code: 'service_exception' },
    })
  })

  it('fails explicitly after full review remains inconclusive twice', async () => {
    const services = scriptedServices({
      reviewFull: vi.fn(async ({ chapters }) =>
        chapters.map(() => ({
          ...review('inconclusive'),
          reason: 'missing_model_result',
        })),
      ),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-full-review-inconclusive',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )

    expect(services.reviewFull).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      phase: 'failed',
      failure: { stage: 'review', code: 'full_review_inconclusive' },
    })
  })

  it('rejects extra full-review results and bounds service exceptions', async () => {
    const extraServices = scriptedServices({
      reviewFull: vi.fn(async () => [review('passed'), review('passed')]),
    })
    const extraResult = await buildWorkflowGraph(extraServices).invoke(
      createWorkflowState({
        jobId: 'job-full-review-extra',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )
    expect(extraServices.reviewFull).toHaveBeenCalledTimes(2)
    expect(extraResult).toMatchObject({
      phase: 'failed',
      failure: { stage: 'review', code: 'service_exception' },
    })

    const throwingServices = scriptedServices({
      reviewFull: vi.fn(async () => {
        throw new Error('provider timeout')
      }),
    })
    const throwingResult = await buildWorkflowGraph(throwingServices).invoke(
      createWorkflowState({
        jobId: 'job-full-review-exception',
        topic: '失败',
        interventionOnOutline: false,
      }),
    )
    expect(throwingServices.reviewFull).toHaveBeenCalledTimes(2)
    expect(throwingResult).toMatchObject({
      phase: 'failed',
      failure: { stage: 'review', code: 'service_exception' },
    })
  })

  it('rewrites only failed chapters after full review and exports warnings after round two', async () => {
    const written: string[] = []
    const services = scriptedServices({
      plan: vi.fn(async () => ['甲', '乙']),
      writeChapter: vi.fn(async ({ chapterTitle, budgetUsage }) => {
        written.push(chapterTitle)
        return readyWriter(`${chapterTitle}-${written.length}`, budgetUsage)
      }),
      reviewFull: vi
        .fn<WorkflowServices['reviewFull']>()
        .mockResolvedValueOnce([review('failed', '甲需重写'), review('passed')])
        .mockResolvedValueOnce([review('failed', '甲仍不足'), review('passed')]),
    })
    const result = await buildWorkflowGraph(services).invoke(
      createWorkflowState({
        jobId: 'job-full-review',
        topic: '全文审稿',
        interventionOnOutline: false,
      }),
    )

    expect(written).toEqual(['甲', '乙', '甲'])
    expect(result.phase).toBe('completed')
    expect(result.fullReviewRound).toBe(2)
    expect(result.qualityWarnings).toContain(
      '全文第 2 轮仍未通过：甲：甲仍不足',
    )
  })
})
