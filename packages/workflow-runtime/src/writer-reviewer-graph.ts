import {
  END,
  START,
  Command,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph'
import {
  appendEditorialDecision,
  mergeSourceNotebook,
  type ReviewReport,
} from '@vibe-writer/agent-core'
import { ReplyRequestSchema } from '@vibe-writer/contracts/jobs'
import { z } from 'zod'
import { componentInconclusiveDecision, terminalFailure, writerInconclusiveDecision } from './policy'
import { OutlineCommandSchema, OutlineSchema } from './schemas'
import { ExportIntentSchema } from './state'
import type { WorkflowProgressEvent, WorkflowProgressSink } from './types'
import {
  ArticleReviewResultSchema,
  WriterAgentResultSchema,
  WriterReviewerGraphState,
} from './writer-reviewer-schemas'
import type { WriterReviewerWorkflowState } from './writer-reviewer-state'
import { reviewWarning, routeAfterReview } from './writer-reviewer-policy'
import type { WriterReviewerServices } from './writer-reviewer-types'

export type WriterReviewerNodeName =
  | '__start__'
  | 'plan'
  | 'outline_review'
  | 'revise_outline'
  | 'write_article'
  | 'review_article'
  | 'export'

function sameOutline(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((title, index) => title === right[index])
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function serviceErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') throw error
  return 'service_exception'
}

function failedUpdate(
  _state: WriterReviewerWorkflowState,
  stage: 'plan' | 'outline_review' | 'write' | 'review' | 'export',
  code: string,
  message: string,
) {
  return {
    phase: 'failed' as const,
    failure: terminalFailure({ stage, code, message }),
  }
}

/**
 * v2 的 LangGraph 仍拥有 durable checkpoint/HITL/retry；不同之处是 Writer 对完整文章
 * 负责，Reviewer 作为隔离优化器，只通过 ReviewReport 与 Writer 协作。
 */
export function buildWriterReviewerWorkflowGraph(
  services: WriterReviewerServices,
  options: {
    checkpointer?: BaseCheckpointSaver
    signal?: AbortSignal
    progress?: WorkflowProgressSink
  } = {},
) {
  const emit = async (progress: WorkflowProgressEvent) => options.progress?.(progress)

  const plan: typeof WriterReviewerGraphState.Node = async (state) => {
    const attempts = state.outlineAttempts + 1
    await emit({
      idempotencyKey: 'workflow:v2:stage:plan',
      event: { event: 'stage_update', data: { stage: 'plan' } },
    })
    try {
      const raw = clone(await services.plan({
        brief: clone(state.writingBrief),
        signal: options.signal,
        effectScope: `plan:attempt:${attempts}`,
      }))
      const outline = raw.length === 0 ? [] : OutlineSchema.parse(raw)
      if (outline.length === 0) {
        if (componentInconclusiveDecision(attempts) === 'retry') {
          return { outlineAttempts: attempts }
        }
        return {
          ...failedUpdate(state, 'plan', 'empty_outline', 'Planner returned no usable outline.'),
          outlineAttempts: attempts,
        }
      }
      return {
        outline,
        approvedOutline: state.interventionOnOutline ? [] : outline,
        outlineAttempts: attempts,
        failure: null,
      }
    } catch (error) {
      const code = serviceErrorCode(error)
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return { outlineAttempts: attempts }
      }
      return {
        ...failedUpdate(state, 'plan', code, 'Planner service failed twice.'),
        outlineAttempts: attempts,
      }
    }
  }

  const outlineReview: typeof WriterReviewerGraphState.Node = (state) => {
    const parsed = OutlineCommandSchema.safeParse(
      interrupt({ type: 'outline_review', outline: state.outline }),
    )
    if (!parsed.success) {
      return failedUpdate(
        state, 'outline_review', 'invalid_outline_reply',
        'Outline reply did not match the resume contract.',
      )
    }
    const outline = clone(parsed.data.outline ?? state.outline)
    if (parsed.data.action === 'revise') {
      return {
        phase: 'revise_outline' as const,
        outline,
        outlineAction: 'revise' as const,
        outlineFeedback: parsed.data.message,
      }
    }
    const editorialDecisions = parsed.data.outline && !sameOutline(state.outline, outline)
      ? appendEditorialDecision(state.editorialDecisions, {
          source: 'manual_outline',
          instruction: '用户直接编辑并确认了大纲，后续写作以该结构为准。',
          resultingOutline: outline,
        })
      : state.editorialDecisions
    return {
      phase: 'outline_review' as const,
      outline,
      approvedOutline: outline,
      outlineAction: 'confirm' as const,
      outlineFeedback: '',
      editorialDecisions,
    }
  }

  const reviseOutline: typeof WriterReviewerGraphState.Node = async (state) => {
    const attempts = state.outlineRevisionAttempts + 1
    const round = state.outlineRevisionRound + 1
    try {
      const raw = clone(await services.reviseOutline({
        brief: clone(state.writingBrief),
        outline: clone(state.outline),
        feedback: state.outlineFeedback,
        editorialDecisions: clone(state.editorialDecisions),
        signal: options.signal,
        effectScope: `outline-revise:round:${round}:attempt:${attempts}`,
      }))
      const outline = raw.length === 0 ? [] : OutlineSchema.parse(raw)
      if (outline.length === 0) {
        if (componentInconclusiveDecision(attempts) === 'retry') {
          return { outlineRevisionAttempts: attempts }
        }
        return {
          ...failedUpdate(state, 'outline_review', 'empty_revised_outline', 'Outline revision returned no usable outline.'),
          outlineRevisionAttempts: attempts,
        }
      }
      return {
        phase: 'outline_review' as const,
        outline,
        outlineRevisionRound: round,
        outlineRevisionAttempts: 0,
        outlineAction: 'none' as const,
        editorialDecisions: appendEditorialDecision(state.editorialDecisions, {
          source: 'outline_feedback',
          instruction: state.outlineFeedback,
          resultingOutline: outline,
        }),
        outlineFeedback: '',
      }
    } catch (error) {
      const code = serviceErrorCode(error)
      if (componentInconclusiveDecision(attempts) === 'retry') {
        return { outlineRevisionAttempts: attempts }
      }
      return {
        ...failedUpdate(state, 'outline_review', code, 'Outline revision service failed twice.'),
        outlineRevisionAttempts: attempts,
      }
    }
  }

  const writeArticle: typeof WriterReviewerGraphState.Node = async (state) => {
    const attempt = state.writerAttemptInRound + 1
    const cycle = state.reviewRound + 1
    const draftTitle = `完整文章草稿（第 ${cycle} 版）`
    await emit({
      idempotencyKey: `workflow:v2:stage:write:cycle:${cycle}`,
      event: { event: 'stage_update', data: { stage: 'write' } },
    })
    await emit({
      idempotencyKey: `workflow:v2:write:cycle:${cycle}:attempt:${attempt}:started`,
      event: { event: 'writing_chapter', data: { title: draftTitle, token: '' } },
    })
    try {
      const result = WriterAgentResultSchema.parse(clone(await services.writeArticle({
        brief: clone(state.writingBrief),
        approvedOutline: clone(state.approvedOutline),
        editorialDecisions: clone(state.editorialDecisions),
        session: clone(state.writerSession),
        reviewReport: clone(state.reviewReport),
        ...(state.partialDraft ? { continuationPrefix: state.partialDraft } : {}),
        signal: options.signal,
        effectScope: `article:cycle:${cycle}:attempt:${attempt}`,
        onSearchProgress: async (progress) => {
          const scope = `workflow:v2:write:cycle:${cycle}:attempt:${attempt}:search:${progress.index}`
          await emit(progress.phase === 'started'
            ? {
                idempotencyKey: `${scope}:started`,
                event: { event: 'searching', data: {
                  title: draftTitle, query: progress.query, index: progress.index,
                } },
              }
            : {
                idempotencyKey: `${scope}:finished`,
                event: { event: 'search_done', data: {
                  title: draftTitle, query: progress.query,
                  preview: progress.preview, chars: progress.chars,
                } },
              })
        },
      })))
      const sourceNotebook = mergeSourceNotebook(state.sourceNotebook, result.sources)
      if (result.status === 'inconclusive') {
        if (writerInconclusiveDecision(result.reason, attempt) === 'retry') {
          return {
            writerSession: result.session,
            sourceNotebook,
            writerAttemptInRound: attempt,
            partialDraft: result.reason === 'max_tokens' ? result.partialDraft : '',
          }
        }
        return {
          ...failedUpdate(state, 'write', result.reason, 'Writer Agent did not produce a complete article.'),
          writerSession: result.session,
          sourceNotebook,
          writerAttemptInRound: attempt,
        }
      }
      await emit({
        idempotencyKey: `workflow:v2:write:cycle:${cycle}:attempt:${attempt}:draft`,
        event: { event: 'writing_chapter', data: {
          title: draftTitle, token: result.draft,
        } },
      })
      return {
        phase: 'review' as const,
        draft: result.draft,
        partialDraft: '',
        writerSession: result.session,
        sourceNotebook,
        writerAttemptInRound: 0,
        reviewReport: null,
      }
    } catch (error) {
      const code = serviceErrorCode(error)
      if (componentInconclusiveDecision(attempt) === 'retry') {
        return { writerAttemptInRound: attempt }
      }
      return {
        ...failedUpdate(state, 'write', code, 'Writer Agent service failed twice.'),
        writerAttemptInRound: attempt,
      }
    }
  }

  const reviewArticle: typeof WriterReviewerGraphState.Node = async (state) => {
    const attempts = state.reviewAttempts + 1
    const round = state.reviewRound + 1
    await emit({
      idempotencyKey: `workflow:v2:stage:review:round:${round}`,
      event: { event: 'stage_update', data: { stage: 'review' } },
    })
    await emit({
      idempotencyKey: `workflow:v2:review:round:${round}:attempt:${attempts}:started`,
      event: { event: 'reviewing_full', data: {} },
    })
    let result: z.infer<typeof ArticleReviewResultSchema>
    try {
      result = ArticleReviewResultSchema.parse(clone(await services.reviewArticle({
        brief: clone(state.writingBrief),
        approvedOutline: clone(state.approvedOutline),
        editorialDecisions: clone(state.editorialDecisions),
        sources: clone(state.sourceNotebook),
        draft: state.draft,
        signal: options.signal,
        effectScope: `article-review:round:${round}:attempt:${attempts}`,
      })))
    } catch (error) {
      const code = serviceErrorCode(error)
      if (componentInconclusiveDecision(attempts) === 'retry') return { reviewAttempts: attempts }
      return {
        ...failedUpdate(state, 'review', code, 'Reviewer Agent service failed twice.'),
        reviewAttempts: attempts,
      }
    }
    if (result.status === 'inconclusive') {
      if (componentInconclusiveDecision(attempts) === 'retry') return { reviewAttempts: attempts }
      return {
        ...failedUpdate(state, 'review', result.reason, 'Reviewer Agent returned invalid output twice.'),
        reviewAttempts: attempts,
      }
    }
    const report = result.report as ReviewReport
    const route = routeAfterReview(report, round)
    await emit({
      idempotencyKey: `workflow:v2:review:round:${round}:attempt:${attempts}:finished`,
      event: { event: 'review_done', data: { results: [{
        title: '完整文章草稿',
        passed: report.verdict === 'approved',
        feedback: route === 'export_with_warnings'
          ? `已达审核轮次上限：${report.summary}`
          : report.summary,
      }] } },
    })
    if (route === 'revise') {
      return {
        phase: 'write' as const,
        reviewReport: report,
        reviewRound: round,
        reviewAttempts: 0,
        writerAttemptInRound: 0,
        partialDraft: '',
      }
    }
    return {
      phase: 'export' as const,
      reviewReport: report,
      reviewRound: round,
      reviewAttempts: 0,
      qualityWarnings: route === 'export_with_warnings'
        ? [...state.qualityWarnings, reviewWarning(report, round)]
        : state.qualityWarnings,
    }
  }

  const exportArticle: typeof WriterReviewerGraphState.Node = async (state) => {
    await emit({
      idempotencyKey: `workflow:v2:stage:export:round:${state.reviewRound}`,
      event: { event: 'stage_update', data: { stage: 'export' } },
    })
    const exportIntent = ExportIntentSchema.parse({
      idempotencyKey: `job:${state.jobId}:article:export`,
      markdown: state.draft,
    })
    return {
      phase: 'completed' as const,
      finalContent: state.draft,
      exportIntent,
    }
  }

  const builder = new StateGraph(WriterReviewerGraphState)
    .addNode('plan', plan)
    .addNode('outline_review', outlineReview)
    .addNode('revise_outline', reviseOutline)
    .addNode('write_article', writeArticle)
    .addNode('review_article', reviewArticle)
    .addNode('export', exportArticle)
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', (state) => {
      if (state.phase === 'failed') return END
      if (state.outline.length === 0) return 'plan'
      return state.interventionOnOutline ? 'outline_review' : 'write_article'
    })
    .addConditionalEdges('outline_review', (state) => {
      if (state.phase === 'failed') return END
      return state.outlineAction === 'revise' ? 'revise_outline' : 'write_article'
    })
    .addConditionalEdges('revise_outline', (state) => {
      if (state.phase === 'failed') return END
      return state.phase === 'revise_outline' ? 'revise_outline' : 'outline_review'
    })
    .addConditionalEdges('write_article', (state) => {
      if (state.phase === 'failed') return END
      return state.writerAttemptInRound > 0 ? 'write_article' : 'review_article'
    })
    .addConditionalEdges('review_article', (state) => {
      if (state.phase === 'failed') return END
      if (state.reviewAttempts > 0) return 'review_article'
      return state.phase === 'write' ? 'write_article' : 'export'
    })
    .addEdge('export', END)

  const compiled = builder.compile({ checkpointer: options.checkpointer })
  const bounded = <T extends { recursionLimit?: number } | undefined>(config: T) => ({
    ...config,
    recursionLimit: config?.recursionLimit ?? 40,
  })
  return {
    invoke: async (
      input: Parameters<typeof compiled.invoke>[0],
      config?: Parameters<typeof compiled.invoke>[1],
    ) => {
      if (
        !options.checkpointer && input && typeof input === 'object'
        && 'interventionOnOutline' in input && input.interventionOnOutline === true
      ) {
        throw new Error('Outline intervention requires a checkpointer and thread_id.')
      }
      return compiled.invoke(input, bounded(config))
    },
    replay: (config: Parameters<typeof compiled.getState>[0]) => compiled.invoke(null, bounded(config)),
    getState: (config: Parameters<typeof compiled.getState>[0]) => compiled.getState(config),
    getStateHistory: (config: Parameters<typeof compiled.getStateHistory>[0]) => compiled.getStateHistory(config),
  }
}

export function resumeWriterReviewerOutline(
  reply: z.input<typeof OutlineCommandSchema> | z.input<typeof ReplyRequestSchema>,
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
  return new Command<unknown, typeof WriterReviewerGraphState.Update, WriterReviewerNodeName>({
    resume: normalized,
  })
}
