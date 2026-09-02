import { MemorySaver, isInterrupted } from '@langchain/langgraph'
import {
  REVIEW_REPORT_VERSION,
  WRITER_SESSION_VERSION,
  type ReviewReport,
  type WriterAgentResult,
} from '@vibe-writer/agent-core'
import { describe, expect, it, vi } from 'vitest'
import {
  WRITER_REVIEWER_WORKFLOW_VERSION,
  WriterReviewerWorkflowStateSchema,
  buildWriterReviewerWorkflowGraph,
  createWriterReviewerWorkflowState,
  resumeWriterReviewerOutline,
  routeAfterReview,
  type WriterReviewerServices,
} from '../src'

const approvedReport = (): ReviewReport => ({
  version: REVIEW_REPORT_VERSION,
  verdict: 'approved',
  summary: '结构、风格与连贯性通过。',
  globalIssues: [],
  localIssues: [],
})

const revisionReport = (): ReviewReport => ({
  version: REVIEW_REPORT_VERSION,
  verdict: 'needs_revision',
  summary: '第二章与第一章之间缺少承接。',
  globalIssues: ['全文两章像独立短文，缺少共同主线。'],
  localIssues: [{
    section: '第二章',
    issue: '开头重新定义了第一章已经解释的概念。',
    suggestion: '用一句转场承接第一章结论，再进入新的案例。',
  }],
})

function readyWriter(
  draft: string,
  messages: WriterAgentResult['session']['messages'] = [],
): WriterAgentResult {
  return {
    status: 'ready',
    draft,
    session: {
      version: WRITER_SESSION_VERSION,
      messages,
      budgetUsage: { totalCalls: 0, callsByTool: {} },
    },
    sources: [],
    executions: [],
    modelCalls: [],
  }
}

function services(overrides: Partial<WriterReviewerServices> = {}): WriterReviewerServices {
  return {
    plan: vi.fn(async () => ['第一章', '第二章']),
    reviseOutline: vi.fn(async ({ outline }) => outline),
    writeArticle: vi.fn(async () => readyWriter(
      '# 主题\n\n## 第一章\n建立问题。\n\n## 第二章\n承接第一章并给出答案。',
    )),
    reviewArticle: vi.fn(async () => ({
      status: 'ready' as const,
      report: approvedReport(),
      source: 'model' as const,
    })),
    ...overrides,
  }
}

function interruptValue(result: unknown) {
  expect(isInterrupted(result)).toBe(true)
  return (result as { __interrupt__: Array<{ value: unknown }> }).__interrupt__[0]?.value
}

describe('writer-reviewer workflow v2 artifacts', () => {
  it('builds a versioned checkpoint state whose brief carries custom style from planning onward', () => {
    const state = createWriterReviewerWorkflowState({
      jobId: 'job-style',
      topic: '为什么缓存会失效',
      style: '幽默风趣',
      targetWords: 1800,
      interventionOnOutline: false,
    })
    expect(state.workflowVersion).toBe(WRITER_REVIEWER_WORKFLOW_VERSION)
    expect(state.writingBrief).toMatchObject({
      topic: '为什么缓存会失效',
      style: '幽默风趣',
      targetWords: 1800,
      styleInstruction: expect.stringContaining('幽默风趣'),
    })
    expect(WriterReviewerWorkflowStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it('passes the same brief to Planner, Writer and isolated Reviewer; first draft is one full article', async () => {
    const workflowServices = services()
    const result = await buildWriterReviewerWorkflowGraph(workflowServices).invoke(
      createWriterReviewerWorkflowState({
        jobId: 'job-full-draft',
        topic: '主题',
        style: '幽默风趣',
        interventionOnOutline: false,
      }),
    )

    expect(workflowServices.plan).toHaveBeenCalledWith(expect.objectContaining({
      brief: expect.objectContaining({ style: '幽默风趣' }),
    }))
    expect(workflowServices.writeArticle).toHaveBeenCalledWith(expect.objectContaining({
      approvedOutline: ['第一章', '第二章'],
      brief: expect.objectContaining({ style: '幽默风趣' }),
      session: expect.objectContaining({ messages: [] }),
    }))
    expect(workflowServices.reviewArticle).toHaveBeenCalledWith(expect.objectContaining({
      draft: '# 主题\n\n## 第一章\n建立问题。\n\n## 第二章\n承接第一章并给出答案。',
      sources: { version: 'source-notebook-v1', sources: [] },
    }))
    const reviewerInput = vi.mocked(workflowServices.reviewArticle).mock.calls[0]?.[0]
    expect(reviewerInput).not.toHaveProperty('session')
    expect(result.finalContent).toBe(result.draft)
  })

  it('retains outline feedback as a bounded editorial decision consumed by Writer', async () => {
    const workflowServices = services({
      plan: vi.fn(async () => ['旧章节']),
      reviseOutline: vi.fn(async () => ['用事故现场开场', '解释修复机制']),
    })
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'writer-reviewer-outline' } }
    let graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer })
    const first = await graph.invoke(
      createWriterReviewerWorkflowState({ jobId: 'job-feedback', topic: '缓存', style: '幽默风趣' }),
      config,
    )
    expect(interruptValue(first)).toEqual({ type: 'outline_review', outline: ['旧章节'] })

    graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer })
    const revised = await graph.invoke(
      resumeWriterReviewerOutline({ action: 'revise', message: '开头更有戏剧性，但不要牺牲事实。' }),
      config,
    )
    expect(interruptValue(revised)).toEqual({
      type: 'outline_review',
      outline: ['用事故现场开场', '解释修复机制'],
    })

    graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer })
    const completed = await graph.invoke(resumeWriterReviewerOutline({ action: 'confirm' }), config)
    const writerInput = vi.mocked(workflowServices.writeArticle).mock.calls[0]?.[0]
    expect(writerInput?.editorialDecisions).toEqual([
      expect.objectContaining({
        source: 'outline_feedback',
        instruction: '开头更有戏剧性，但不要牺牲事实。',
        resultingOutline: ['用事故现场开场', '解释修复机制'],
      }),
    ])
    expect(completed.editorialDecisions).toEqual(writerInput?.editorialDecisions)
  })

  it('gives every human outline revision round a distinct durable effect scope', async () => {
    const reviseOutline = vi.fn(async ({ editorialDecisions }) => [
      `第 ${editorialDecisions.length + 1} 版章节`,
    ])
    const workflowServices = services({ plan: vi.fn(async () => ['初版章节']), reviseOutline })
    const checkpointer = new MemorySaver()
    const config = { configurable: { thread_id: 'writer-reviewer-three-revisions' } }
    let graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer })
    await graph.invoke(createWriterReviewerWorkflowState({
      jobId: 'job-three-revisions', topic: '主题', interventionOnOutline: true,
    }), config)

    for (const message of ['更具体', '增加案例', '调整结尾']) {
      graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer })
      const interrupted = await graph.invoke(
        resumeWriterReviewerOutline({ action: 'revise', message }),
        config,
      )
      expect(isInterrupted(interrupted)).toBe(true)
    }
    graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer })
    await graph.invoke(resumeWriterReviewerOutline({ action: 'confirm' }), config)

    expect(reviseOutline.mock.calls.map(([input]) => input.effectScope)).toEqual([
      'outline-revise:round:1:attempt:1',
      'outline-revise:round:2:attempt:1',
      'outline-revise:round:3:attempt:1',
    ])
  })

  it('routes structured review feedback back into the same Writer session', async () => {
    const firstMessages: WriterAgentResult['session']['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'initial brief' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first complete draft' }] },
    ]
    const writeArticle = vi
      .fn<WriterReviewerServices['writeArticle']>()
      .mockResolvedValueOnce(readyWriter(
        '# 主题\n\n## 第一章\n初稿一。\n\n## 第二章\n初稿二。',
        firstMessages,
      ))
      .mockImplementationOnce(async ({ session, reviewReport }) => {
        expect(session.messages).toEqual(firstMessages)
        expect(reviewReport).toEqual(revisionReport())
        return readyWriter(
          '# 主题\n\n## 第一章\n初稿一。\n\n## 第二章\n沿着上一章的问题，给出答案。',
          [...session.messages, { role: 'user', content: [{ type: 'text', text: 'structured review' }] }],
        )
      })
    const reviewArticle = vi
      .fn<WriterReviewerServices['reviewArticle']>()
      .mockResolvedValueOnce({ status: 'ready', report: revisionReport(), source: 'model' })
      .mockResolvedValueOnce({ status: 'ready', report: approvedReport(), source: 'model' })

    const result = await buildWriterReviewerWorkflowGraph(services({
      writeArticle,
      reviewArticle,
    })).invoke(createWriterReviewerWorkflowState({
      jobId: 'job-revision', topic: '主题', interventionOnOutline: false,
    }))

    expect(writeArticle).toHaveBeenCalledTimes(2)
    expect(reviewArticle).toHaveBeenCalledTimes(2)
    expect(result.reviewRound).toBe(2)
    expect(result.finalContent).toContain('沿着上一章的问题')
  })

  it('continues a max_tokens partial draft with the persisted Writer session', async () => {
    const partialMessages: WriterAgentResult['session']['messages'] = [
      { role: 'assistant', content: [{ type: 'text', text: '# 主题\n\n## 第一章\n前半段' }] },
    ]
    const writeArticle = vi
      .fn<WriterReviewerServices['writeArticle']>()
      .mockImplementationOnce(async ({ onSearchProgress }) => {
        await onSearchProgress?.({ phase: 'started', query: '第一次查询', index: 1 })
        return {
          status: 'inconclusive',
          reason: 'max_tokens',
          partialDraft: '# 主题\n\n## 第一章\n前半段',
          session: {
            version: WRITER_SESSION_VERSION,
            messages: partialMessages,
            budgetUsage: { totalCalls: 1, callsByTool: { search: 1 } },
          },
          sources: [], executions: [], modelCalls: [],
        }
      })
      .mockImplementationOnce(async ({ session, continuationPrefix, onSearchProgress }) => {
        expect(session.messages).toEqual(partialMessages)
        expect(session.budgetUsage).toEqual({ totalCalls: 1, callsByTool: { search: 1 } })
        expect(continuationPrefix).toContain('前半段')
        await onSearchProgress?.({ phase: 'started', query: '续写查询', index: 1 })
        return readyWriter(`${continuationPrefix}\n\n## 第二章\n后半段`, session.messages)
      })

    const progress = vi.fn()
    const result = await buildWriterReviewerWorkflowGraph(services({ writeArticle }), { progress }).invoke(
      createWriterReviewerWorkflowState({
        jobId: 'job-continuation', topic: '主题', interventionOnOutline: false,
      }),
    )
    expect(writeArticle).toHaveBeenCalledTimes(2)
    expect(result.finalContent).toContain('## 第二章\n后半段')
    expect(progress.mock.calls
      .map(([event]) => event.idempotencyKey)
      .filter((key) => key.includes(':search:1:started'))).toEqual([
      'workflow:v2:write:cycle:1:attempt:1:search:1:started',
      'workflow:v2:write:cycle:1:attempt:2:search:1:started',
    ])
  })

  it('exports with an explicit warning when the second review still requests revision', async () => {
    const workflowServices = services({
      reviewArticle: vi.fn(async () => ({
        status: 'ready' as const,
        report: revisionReport(),
        source: 'model' as const,
      })),
    })
    const progress = vi.fn()
    const result = await buildWriterReviewerWorkflowGraph(workflowServices, { progress }).invoke(
      createWriterReviewerWorkflowState({
        jobId: 'job-review-limit', topic: '主题', interventionOnOutline: false,
      }),
    )
    expect(workflowServices.writeArticle).toHaveBeenCalledTimes(2)
    expect(workflowServices.reviewArticle).toHaveBeenCalledTimes(2)
    expect(result.phase).toBe('completed')
    expect(result.qualityWarnings[0]).toContain('第 2 轮全文审核仍需修改')
    expect(routeAfterReview(revisionReport(), 2)).toBe('export_with_warnings')
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        event: 'review_done',
        data: expect.objectContaining({
          results: [expect.objectContaining({ feedback: expect.stringContaining('已达审核轮次上限') })],
        }),
      }),
    }))
  })

  it('replays the terminal checkpoint without repeating Writer or Reviewer effects', async () => {
    const workflowServices = services()
    const saver = new MemorySaver()
    const config = { configurable: { thread_id: 'writer-reviewer-replay' } }
    let graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer: saver })
    const first = await graph.invoke(createWriterReviewerWorkflowState({
      jobId: 'job-replay', topic: '主题', interventionOnOutline: false,
    }), config)
    const terminal = await graph.getState(config)

    graph = buildWriterReviewerWorkflowGraph(workflowServices, { checkpointer: saver })
    const replayed = await graph.replay(terminal.config)
    expect(replayed.finalContent).toBe(first.finalContent)
    expect(workflowServices.writeArticle).toHaveBeenCalledTimes(1)
    expect(workflowServices.reviewArticle).toHaveBeenCalledTimes(1)
  })

  it('rejects a completed checkpoint whose draft and export intent disagree', () => {
    const state = createWriterReviewerWorkflowState({
      jobId: 'job-invalid-export', topic: '主题', interventionOnOutline: false,
    })
    expect(WriterReviewerWorkflowStateSchema.safeParse({
      ...state,
      phase: 'completed',
      outline: ['第一章'],
      approvedOutline: ['第一章'],
      draft: '# 正确正文',
      finalContent: '# 正确正文',
      exportIntent: { idempotencyKey: 'job:invalid:article:export', markdown: '# 另一份正文' },
    }).success).toBe(false)
  })
})
