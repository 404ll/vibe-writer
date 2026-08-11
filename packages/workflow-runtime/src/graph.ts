import {
  END,
  START,
  Command,
  StateGraph,
  StateSchema,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph'
import type {
  CoveragePlanResult,
  ReviewResult,
  WriterResult,
} from '@vibe-writer/agent-core'
import { ReplyRequestSchema } from '@vibe-writer/contracts/jobs'
import { z } from 'zod'
import {
  chapterWords,
  componentInconclusiveDecision,
  fullReviewDecision,
  terminalFailure,
  writerInconclusiveDecision,
} from './policy'
import {
  createChapterState,
  CoveragePointSchema,
  ExportIntentSchema,
  renderMarkdown,
  ToolBudgetUsageSchema,
  WorkflowStateSchema,
  type ChapterWorkflowState,
  type WorkflowState,
} from './state'

export const WorkflowGraphState = new StateSchema(WorkflowStateSchema.shape)

// 这里刻意使用显式状态图，而不是让多个自治智能体自由协商：每个节点的输入、
// 重试、中断和终态路径都可被检查点、固定样例与评测单独验证。

type WorkflowNodeName =
  | '__start__'
  | 'plan'
  | 'outline_review'
  | 'revise_outline'
  | 'initialize_chapters'
  | 'coverage'
  | 'write'
  | 'light_review'
  | 'next_chapter'
  | 'full_review'
  | 'export'

const OutlineSchema = z.array(z.string().trim().min(1)).min(1).max(6)

const OutlineCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('confirm'),
    outline: OutlineSchema.optional(),
  }),
  z.object({
    action: z.literal('revise'),
    message: z.string().trim().min(1),
    outline: OutlineSchema.optional(),
  }),
])

const CoverageResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), points: z.array(CoveragePointSchema).min(1) }),
  z.object({
    status: z.literal('inconclusive'),
    points: z.tuple([]),
    reason: z.literal('invalid_model_output'),
  }),
])

const ReviewResultSchema = z.object({
  verdict: z.enum(['passed', 'failed', 'inconclusive']),
  feedback: z.string(),
  source: z.enum(['deterministic', 'model']),
  reason: z
    .enum(['word_budget_exceeded', 'invalid_model_output', 'missing_model_result'])
    .optional(),
})

const WriterResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    content: z.string().trim().min(1),
    budgetUsage: ToolBudgetUsageSchema,
  }),
  z.object({
    status: z.literal('inconclusive'),
    reason: z.enum([
      'max_tool_rounds',
      'invalid_model_response',
      'empty_final_text',
      'max_tokens',
      'refusal',
      'pause_turn',
    ]),
    budgetUsage: ToolBudgetUsageSchema,
  }),
])

export type WorkflowServices = {
  plan(input: { topic: string; targetWords?: number; signal?: AbortSignal; effectScope?: string }): Promise<string[]>
  reviseOutline(input: {
    topic: string
    outline: string[]
    feedback: string
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<string[]>
  planCoverage(input: {
    topic: string
    outline: string
    chapterTitle: string
    signal?: AbortSignal
    effectScope?: string
  }): Promise<CoveragePlanResult>
  writeChapter(input: {
    topic: string
    outline: string
    chapterTitle: string
    coveragePoints: ChapterWorkflowState['coveragePoints']
    reviewFeedback: string
    chapterWords?: number
    targetWords?: number
    budgetUsage: ChapterWorkflowState['toolBudgetUsage']
    style?: string
    signal?: AbortSignal
    effectScope?: string
  }): Promise<WriterResult>
  reviewChapter(input: {
    chapterTitle: string
    content: string
    outline: string
    chapterWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ReviewResult>
  reviewFull(input: {
    topic: string
    chapters: Array<{ title: string; content: string }>
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ReviewResult[]>
}

function outlineText(state: WorkflowState): string {
  return state.outline.map((title, index) => `${index + 1}. ${title}`).join('\n')
}

function replaceChapter(
  state: WorkflowState,
  index: number,
  update: Partial<ChapterWorkflowState>,
): ChapterWorkflowState[] {
  return state.chapters.map((chapter, chapterIndex) =>
    chapterIndex === index ? { ...chapter, ...update } : chapter,
  )
}

function currentChapter(state: WorkflowState): ChapterWorkflowState | undefined {
  return state.chapters[state.currentChapterIndex]
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function serviceErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') throw error
  return 'service_exception'
}

function failedUpdate(
  state: WorkflowState,
  stage: Parameters<typeof terminalFailure>[0]['stage'],
  code: string,
  message: string,
) {
  return {
    phase: 'failed' as const,
    failure: terminalFailure({
      stage,
      code,
      message,
      ...(currentChapter(state) ? { chapterIndex: state.currentChapterIndex } : {}),
    }),
  }
}

export function buildWorkflowGraph(
  services: WorkflowServices,
  options: { checkpointer?: BaseCheckpointSaver; signal?: AbortSignal } = {},
) {
  const plan: typeof WorkflowGraphState.Node = async (state) => {
    const attempts = state.outlineAttempts + 1
    let outline: string[]
    try {
      const rawOutline = cloneValue(
        await services.plan({
          topic: state.topic,
          ...(state.targetWords ? { targetWords: state.targetWords } : {}),
          signal: options.signal,
          effectScope: `plan:attempt:${attempts}`,
        }),
      )
      outline = rawOutline.length === 0 ? [] : OutlineSchema.parse(rawOutline)
    } catch (error) {
      const code = serviceErrorCode(error)
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return { outline: [], outlineAttempts: attempts }
      }
      return {
        ...failedUpdate(state, 'plan', code, 'Planner service failed twice.'),
        outlineAttempts: attempts,
      }
    }
    if (outline.length === 0 && componentInconclusiveDecision(attempts) === 'terminal') {
      return {
        ...failedUpdate(state, 'plan', 'empty_outline', 'Planner returned no usable chapters.'),
        outlineAttempts: attempts,
      }
    }
    return {
      phase: 'plan',
      outline,
      outlineAttempts: attempts,
      failure: null,
    }
  }

  const outlineReview: typeof WorkflowGraphState.Node = (state) => {
    const parsed = OutlineCommandSchema.safeParse(
      interrupt({ type: 'outline_review', outline: state.outline }),
    )
    if (!parsed.success) {
      return failedUpdate(
        state,
        'outline_review',
        'invalid_outline_reply',
        'Outline reply did not match the resume contract.',
      )
    }
    const outline = parsed.data.outline ?? state.outline
    const action = parsed.data.action
    return {
      phase: action === 'revise' ? 'revise_outline' : 'outline_review',
      outline: cloneValue(outline),
      outlineAction: action,
      outlineFeedback: action === 'revise' ? parsed.data.message : '',
    }
  }

  const reviseOutline: typeof WorkflowGraphState.Node = async (state) => {
    const attempts = state.outlineRevisionAttempts + 1
    let outline: string[]
    try {
      const rawOutline = cloneValue(
        await services.reviseOutline({
          topic: state.topic,
          outline: cloneValue(state.outline),
          feedback: state.outlineFeedback,
          ...(state.targetWords ? { targetWords: state.targetWords } : {}),
          signal: options.signal,
          effectScope: `outline-revise:attempt:${attempts}`,
        }),
      )
      outline = rawOutline.length === 0 ? [] : OutlineSchema.parse(rawOutline)
    } catch (error) {
      const code = serviceErrorCode(error)
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return { phase: 'revise_outline', outlineRevisionAttempts: attempts }
      }
      return {
        ...failedUpdate(
          state,
          'outline_review',
          code,
          'Outline revision service failed twice.',
        ),
        outlineRevisionAttempts: attempts,
      }
    }
    if (outline.length === 0) {
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return { phase: 'revise_outline', outlineRevisionAttempts: attempts }
      }
      return {
        ...failedUpdate(
          state,
          'outline_review',
          'empty_revised_outline',
          'Outline revision returned no usable chapters twice.',
        ),
        outlineRevisionAttempts: attempts,
      }
    }
    return {
      phase: 'outline_review',
      outline,
      outlineRevisionCount: state.outlineRevisionCount + 1,
      outlineRevisionAttempts: 0,
      outlineAction: 'none',
      outlineFeedback: '',
    }
  }

  const initializeChapters: typeof WorkflowGraphState.Node = (state) => ({
    phase: 'write',
    chapters: state.outline.map(createChapterState),
    currentChapterIndex: 0,
    outlineAction: 'none',
    outlineFeedback: '',
  })

  const coverage: typeof WorkflowGraphState.Node = async (state) => {
    const chapter = currentChapter(state)
    if (!chapter || chapter.reviewStatus === 'passed' || chapter.coveragePoints.length > 0) {
      return { phase: 'write' }
    }
    const attempts = chapter.coverageAttempts + 1
    let result: z.infer<typeof CoverageResultSchema>
    try {
      result = CoverageResultSchema.parse(
        cloneValue(
          await services.planCoverage({
            topic: state.topic,
            outline: outlineText(state),
          chapterTitle: chapter.title,
          signal: options.signal,
          effectScope: `chapter:${state.currentChapterIndex}:coverage:attempt:${attempts}`,
          }),
        ),
      )
    } catch (error) {
      const code = serviceErrorCode(error)
      const chapters = replaceChapter(state, state.currentChapterIndex, {
        coverageAttempts: attempts,
      })
      if (componentInconclusiveDecision(attempts) === 'retry') return { chapters }
      return {
        ...failedUpdate(
          state,
          'coverage',
          code,
          `Coverage service failed twice for chapter: ${chapter.title}`,
        ),
        chapters,
      }
    }
    if (result.status === 'inconclusive') {
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return {
          chapters: replaceChapter(state, state.currentChapterIndex, {
            coverageAttempts: attempts,
          }),
        }
      }
      return {
        ...failedUpdate(
          state,
          'coverage',
          result.reason,
          `Coverage planning failed for chapter: ${chapter.title}`,
        ),
        chapters: replaceChapter(state, state.currentChapterIndex, {
          coverageAttempts: attempts,
        }),
      }
    }
    return {
      chapters: replaceChapter(state, state.currentChapterIndex, {
        coverageAttempts: attempts,
        coveragePoints: result.points,
      }),
    }
  }

  const write: typeof WorkflowGraphState.Node = async (state) => {
    const chapter = currentChapter(state)
    if (!chapter) return failedUpdate(state, 'write', 'missing_chapter', 'Chapter index is invalid.')
    const attemptInPass = chapter.writeAttemptInPass + 1
    let result: z.infer<typeof WriterResultSchema>
    try {
      result = WriterResultSchema.parse(
        cloneValue(
          await services.writeChapter({
            topic: state.topic,
            outline: outlineText(state),
            chapterTitle: chapter.title,
            coveragePoints: cloneValue(chapter.coveragePoints),
            reviewFeedback: chapter.reviewFeedback,
            chapterWords: chapterWords(state.targetWords, state.outline.length),
            ...(state.targetWords ? { targetWords: state.targetWords } : {}),
            budgetUsage: cloneValue(chapter.toolBudgetUsage),
            style: state.style,
            signal: options.signal,
            effectScope: `chapter:${state.currentChapterIndex}:write:attempt:${chapter.writeAttempts + 1}`,
          }),
        ),
      )
    } catch (error) {
      const code = serviceErrorCode(error)
      const chapters = replaceChapter(state, state.currentChapterIndex, {
        writeAttempts: chapter.writeAttempts + 1,
        writeAttemptInPass: attemptInPass,
      })
      if (componentInconclusiveDecision(attemptInPass) === 'retry') return { chapters }
      return {
        ...failedUpdate(
          state,
          'write',
          code,
          `Writer service failed twice for chapter: ${chapter.title}`,
        ),
        chapters,
      }
    }
    const common = {
      writeAttempts: chapter.writeAttempts + 1,
      writeAttemptInPass: attemptInPass,
      toolBudgetUsage: cloneValue(result.budgetUsage),
    }
    if (result.status === 'inconclusive') {
      const chapters = replaceChapter(state, state.currentChapterIndex, common)
      if (writerInconclusiveDecision(result.reason, attemptInPass) === 'retry') {
        return { chapters }
      }
      return {
        ...failedUpdate(
          state,
          'write',
          result.reason,
          `Writer did not produce a usable chapter: ${chapter.title}`,
        ),
        chapters,
      }
    }
    return {
      chapters: replaceChapter(state, state.currentChapterIndex, {
        ...common,
        content: result.content,
        writeAttemptInPass: 0,
        lightReviewAttempts: 0,
        lightReviewStatus: 'pending',
        needsRewrite: false,
      }),
    }
  }

  const lightReview: typeof WorkflowGraphState.Node = async (state) => {
    const chapter = currentChapter(state)
    if (!chapter) {
      return failedUpdate(state, 'review', 'missing_chapter', 'Chapter index is invalid.')
    }
    const attempts = chapter.lightReviewAttempts + 1
    let result: z.infer<typeof ReviewResultSchema>
    try {
      result = ReviewResultSchema.parse(
        cloneValue(
          await services.reviewChapter({
            chapterTitle: chapter.title,
            content: chapter.content,
            outline: outlineText(state),
            chapterWords: chapterWords(state.targetWords, state.outline.length),
            signal: options.signal,
            effectScope: `chapter:${state.currentChapterIndex}:review:attempt:${attempts}`,
          }),
        ),
      )
    } catch (error) {
      const code = serviceErrorCode(error)
      const chapters = replaceChapter(state, state.currentChapterIndex, {
        lightReviewAttempts: attempts,
      })
      if (componentInconclusiveDecision(attempts) === 'retry') return { chapters }
      return {
        ...failedUpdate(
          state,
          'review',
          code,
          `Chapter review service failed twice: ${chapter.title}`,
        ),
        chapters,
      }
    }
    if (result.verdict === 'inconclusive') {
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return {
          chapters: replaceChapter(state, state.currentChapterIndex, {
            lightReviewAttempts: attempts,
          }),
        }
      }
      return {
        ...failedUpdate(
          state,
          'review',
          result.reason ?? 'chapter_review_inconclusive',
          `Chapter review stayed inconclusive: ${chapter.title}`,
        ),
        chapters: replaceChapter(state, state.currentChapterIndex, {
          lightReviewAttempts: attempts,
        }),
      }
    }
    if (result.verdict === 'failed' && chapter.lightRewriteCount < 1) {
      return {
        chapters: replaceChapter(state, state.currentChapterIndex, {
          lightReviewAttempts: attempts,
          lightReviewStatus: 'failed',
          reviewFeedback: result.feedback,
          lightRewriteCount: chapter.lightRewriteCount + 1,
          writeAttemptInPass: 0,
          needsRewrite: true,
        }),
      }
    }
    return {
      chapters: replaceChapter(state, state.currentChapterIndex, {
        lightReviewAttempts: attempts,
        lightReviewStatus: result.verdict,
        needsRewrite: false,
        reviewFeedback: result.verdict === 'failed' ? result.feedback : '',
      }),
      qualityWarnings:
        result.verdict === 'failed'
          ? [...state.qualityWarnings, `轻审未通过：${chapter.title}：${result.feedback}`]
          : state.qualityWarnings,
    }
  }

  const nextChapter: typeof WorkflowGraphState.Node = (state) => ({
    currentChapterIndex: state.currentChapterIndex + 1,
  })

  const fullReview: typeof WorkflowGraphState.Node = async (state) => {
    const attempts = state.fullReviewAttempts + 1
    let results: Array<z.infer<typeof ReviewResultSchema>>
    try {
      const rawResults = cloneValue(
        await services.reviewFull({
          topic: state.topic,
          chapters: state.chapters.map(({ title, content }) => ({ title, content })),
          ...(state.targetWords ? { targetWords: state.targetWords } : {}),
          signal: options.signal,
          effectScope: `full-review:attempt:${attempts}`,
        }),
      )
      if (rawResults.length !== state.chapters.length) {
        throw new Error('Full review result count does not match the chapter count.')
      }
      results = z.array(ReviewResultSchema).parse(rawResults)
    } catch (error) {
      const code = serviceErrorCode(error)
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return { phase: 'review', fullReviewAttempts: attempts }
      }
      return {
        ...failedUpdate(
          state,
          'review',
          code,
          'Full review service failed or returned an invalid result twice.',
        ),
        fullReviewAttempts: attempts,
      }
    }
    const normalized = state.chapters.map(
      (_, index) =>
        results[index] ?? ({
          verdict: 'inconclusive',
          feedback: 'Missing full review result.',
          source: 'model',
          reason: 'missing_model_result',
        } satisfies ReviewResult),
    )
    if (normalized.some((result) => result.verdict === 'inconclusive')) {
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return { phase: 'review', fullReviewAttempts: attempts }
      }
      return {
        ...failedUpdate(
          state,
          'review',
          'full_review_inconclusive',
          'Full review stayed inconclusive after the retry budget.',
        ),
        fullReviewAttempts: attempts,
      }
    }

    const round = state.fullReviewRound + 1
    const chapters = state.chapters.map((chapter, index) => {
      const result = normalized[index] as ReviewResult
      return {
        ...chapter,
        reviewStatus: result.verdict === 'passed' ? 'passed' : 'failed',
        reviewFeedback: result.verdict === 'failed' ? result.feedback : '',
      } satisfies ChapterWorkflowState
    })
    const failed = chapters.filter((chapter) => chapter.reviewStatus === 'failed')
    const decision = fullReviewDecision(failed.length, round)
    if (decision === 'export') {
      return {
        phase: 'export',
        chapters,
        fullReviewRound: round,
        fullReviewAttempts: 0,
      }
    }
    if (decision === 'export_with_warnings') {
      return {
        phase: 'export',
        chapters,
        fullReviewRound: round,
        fullReviewAttempts: 0,
        qualityWarnings: [
          ...state.qualityWarnings,
          ...failed.map(
            (chapter) => `全文第 ${round} 轮仍未通过：${chapter.title}：${chapter.reviewFeedback}`,
          ),
        ],
      }
    }
    return {
      phase: 'write',
      chapters: chapters.map((chapter) =>
        chapter.reviewStatus === 'failed'
          ? {
              ...chapter,
              lightReviewStatus: 'pending' as const,
              lightReviewAttempts: 0,
              writeAttemptInPass: 0,
              fullRewriteCount: chapter.fullRewriteCount + 1,
              needsRewrite: true,
            }
          : chapter,
      ),
      currentChapterIndex: 0,
      fullReviewRound: round,
      fullReviewAttempts: 0,
    }
  }

  const exportArticle: typeof WorkflowGraphState.Node = (state) => {
    const markdown = renderMarkdown(state.topic, state.chapters)
    const exportIntent = ExportIntentSchema.parse({
      idempotencyKey: `job:${state.jobId}:article:export`,
      markdown,
    })
    return {
      phase: 'completed',
      finalContent: markdown,
      exportIntent,
    }
  }

  const builder = new StateGraph(WorkflowGraphState)
    .addNode('plan', plan)
    .addNode('outline_review', outlineReview)
    .addNode('revise_outline', reviseOutline)
    .addNode('initialize_chapters', initializeChapters)
    .addNode('coverage', coverage)
    .addNode('write', write)
    .addNode('light_review', lightReview)
    .addNode('next_chapter', nextChapter)
    .addNode('full_review', fullReview)
    .addNode('export', exportArticle)
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', (state) => {
      if (state.phase === 'failed') return END
      if (state.outline.length === 0) return 'plan'
      return state.interventionOnOutline ? 'outline_review' : 'initialize_chapters'
    })
    .addConditionalEdges('outline_review', (state) => {
      if (state.phase === 'failed') return END
      return state.outlineAction === 'revise' ? 'revise_outline' : 'initialize_chapters'
    })
    .addConditionalEdges('revise_outline', (state) => {
      if (state.phase === 'failed') return END
      return state.phase === 'revise_outline' ? 'revise_outline' : 'outline_review'
    })
    .addEdge('initialize_chapters', 'coverage')
    .addConditionalEdges('coverage', (state) => {
      if (state.phase === 'failed') return END
      const chapter = currentChapter(state)
      if (!chapter) return 'full_review'
      if (chapter.reviewStatus === 'passed') return 'next_chapter'
      if (chapter.coveragePoints.length === 0) return 'coverage'
      return 'write'
    })
    .addConditionalEdges('write', (state) => {
      if (state.phase === 'failed') return END
      const chapter = currentChapter(state)
      return chapter?.writeAttemptInPass ? 'write' : 'light_review'
    })
    .addConditionalEdges('light_review', (state) => {
      if (state.phase === 'failed') return END
      const chapter = currentChapter(state)
      if (!chapter) return END
      if (chapter.needsRewrite) return 'write'
      if (chapter.lightReviewStatus === 'pending') return 'light_review'
      return 'next_chapter'
    })
    .addConditionalEdges('next_chapter', (state) =>
      state.currentChapterIndex >= state.chapters.length ? 'full_review' : 'coverage',
    )
    .addConditionalEdges('full_review', (state) => {
      if (state.phase === 'failed') return END
      if (state.phase === 'review') return 'full_review'
      return state.phase === 'write' ? 'coverage' : 'export'
    })
    .addEdge('export', END)

  const compiled = builder.compile({ checkpointer: options.checkpointer })
  const withRecursionLimit = <T extends { recursionLimit?: number } | undefined>(config: T) => ({
    ...config,
    recursionLimit: config?.recursionLimit ?? 100,
  })

  return {
    invoke: async (
      input: Parameters<typeof compiled.invoke>[0],
      config?: Parameters<typeof compiled.invoke>[1],
    ) => {
      if (
        !options.checkpointer &&
        input &&
        typeof input === 'object' &&
        'interventionOnOutline' in input &&
        input.interventionOnOutline === true
      ) {
        throw new Error('Outline intervention requires a checkpointer and thread_id.')
      }
      return compiled.invoke(input, withRecursionLimit(config))
    },
    replay: (config: Parameters<typeof compiled.getState>[0]) =>
      compiled.invoke(null, withRecursionLimit(config)),
    getState: (
      config: Parameters<typeof compiled.getState>[0],
      options?: Parameters<typeof compiled.getState>[1],
    ) => compiled.getState(config, options),
    getStateHistory: (
      config: Parameters<typeof compiled.getStateHistory>[0],
      options?: Parameters<typeof compiled.getStateHistory>[1],
    ) => compiled.getStateHistory(config, options),
  }
}

export function resumeOutline(
  reply:
    | z.input<typeof OutlineCommandSchema>
    | z.input<typeof ReplyRequestSchema>,
) {
  const explicit = OutlineCommandSchema.safeParse(reply)
  let normalized: z.infer<typeof OutlineCommandSchema>
  if (explicit.success) {
    normalized = explicit.data
  } else {
    const legacy = ReplyRequestSchema.parse(reply)
    const outline = legacy.outline ?? undefined
    const message = legacy.message.trim()
    normalized = OutlineCommandSchema.parse(
      message && message !== '确认'
        ? { action: 'revise', message, ...(outline ? { outline } : {}) }
        : message === '确认' || outline
          ? { action: 'confirm', ...(outline ? { outline } : {}) }
          : {},
    )
  }
  return new Command<unknown, typeof WorkflowGraphState.Update, WorkflowNodeName>({
    resume: normalized,
  })
}
