import {
  END,
  START,
  Command,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph'
import type { ReviewResult } from '@vibe-writer/agent-core'
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
  CoverageResultSchema,
  OutlineCommandSchema,
  OutlineSchema,
  ReviewResultSchema,
  WorkflowGraphState,
  WriterResultSchema,
} from './schemas'
import {
  createChapterState,
  ExportIntentSchema,
  renderMarkdown,
  type ChapterWorkflowState,
  type WorkflowState,
} from './state'
import type {
  WorkflowNodeName,
  WorkflowProgressEvent,
  WorkflowProgressSink,
  WorkflowServices,
} from './types'

// 本文件只保留真正推进工作流的运行逻辑：辅助函数、节点实现、条件边、
// Graph 编译和人工恢复入口。编译期类型在 types.ts，运行时校验在 schemas.ts。
// 这里刻意使用显式状态图而不是自治协商，使重试、中断和终态路径可单独验证。

// 将数组形式的大纲转换成适合传给模型的编号文本；不修改原 State。
function outlineText(state: WorkflowState): string {
  return state.outline.map((title, index) => `${index + 1}. ${title}`).join('\n')
}

// LangGraph 节点返回的是 State 的部分更新。这里用不可变方式只替换指定章节，
// 避免原地修改 state.chapters 导致 Checkpoint 前后引用混乱。
function replaceChapter(
  state: WorkflowState,
  index: number,
  update: Partial<ChapterWorkflowState>,
): ChapterWorkflowState[] {
  return state.chapters.map((chapter, chapterIndex) =>
    chapterIndex === index ? { ...chapter, ...update } : chapter,
  )
}

// 所有逐章节点都通过 currentChapterIndex 获取当前处理对象。
function currentChapter(state: WorkflowState): ChapterWorkflowState | undefined {
  return state.chapters[state.currentChapterIndex]
}

// 隔离服务返回值与 Workflow State 的引用，防止适配器后续修改对象时污染已提交状态。
function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

// 用户取消和租约丢失最终都会表现为 AbortError，必须继续抛给 Worker Runner；
// 其他领域服务异常才收敛成可进入工作流失败策略的统一错误码。
function serviceErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') throw error
  return 'service_exception'
}

// 把任意节点错误统一投影成合法的 failed State，并在逐章阶段记录出错章节。
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

/**
 * 组装完整写作状态图。
 *
 * `services` 提供节点需要的领域能力；`checkpointer` 持久化节点进度；
 * `signal` 把 Worker 的取消或租约丢失传递到模型、搜索和 Graph 节点。
 */
export function buildWorkflowGraph(
  services: WorkflowServices,
  options: {
    checkpointer?: BaseCheckpointSaver
    signal?: AbortSignal
    progress?: WorkflowProgressSink
  } = {},
) {
  // Graph 只负责“当前节点做什么、下一步去哪里”；模型、搜索等具体能力由
  // services 注入。这样节点可独立测试，Graph State 也保持可持久化。
  const emitProgress = async (progress: WorkflowProgressEvent) => {
    await options.progress?.(progress)
  }

  // 节点 plan：生成初始大纲。
  // 成功后进入人工确认或章节初始化；无效结果按策略再试一次，耗尽预算则 failed。
  const plan: typeof WorkflowGraphState.Node = async (state) => {
    const attempts = state.outlineAttempts + 1
    await emitProgress({
      idempotencyKey: 'workflow:stage:plan',
      event: { event: 'stage_update', data: { stage: 'plan' } },
    })
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

  // 节点 outline_review：工作流唯一的人工中断点。
  // 用户确认后进入 initialize_chapters；要求修改则进入 revise_outline。
  const outlineReview: typeof WorkflowGraphState.Node = (state) => {
    // interrupt() 不是让 Worker 进程原地等待。LangGraph 会先通过 checkpointer
    // 保存当前 State 并结束本次执行；恢复时它才返回用户提交的 confirm/revise。
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

  // 节点 revise_outline：使用用户反馈生成新大纲。
  // 成功后清空上一次 action/feedback 并回到 outline_review，再让用户确认。
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

  // 节点 initialize_chapters：把大纲标题变成带重试、审核和工具预算字段的章节状态。
  // 这里只初始化数据，不调用模型；下一节点固定为 coverage。
  const initializeChapters: typeof WorkflowGraphState.Node = async (state) => {
    await emitProgress({
      idempotencyKey: 'workflow:stage:write:round:0',
      event: { event: 'stage_update', data: { stage: 'write' } },
    })
    return {
      phase: 'write',
      chapters: state.outline.map(createChapterState),
      currentChapterIndex: 0,
      outlineAction: 'none',
      outlineFeedback: '',
    }
  }

  // 节点 coverage：为当前章节准备写作覆盖点。
  // 已审核通过或已有覆盖点的章节会直接跳过；否则生成覆盖点后进入 write。
  const coverage: typeof WorkflowGraphState.Node = async (state) => {
    const chapter = currentChapter(state)
    if (!chapter || chapter.reviewStatus === 'passed' || chapter.coveragePoints.length > 0) {
      return { phase: 'write' }
    }
    const attempts = chapter.coverageAttempts + 1
    const scope = `workflow:chapter:${state.currentChapterIndex}:coverage:attempt:${attempts}`
    await emitProgress({
      idempotencyKey: `${scope}:generating-opinions`,
      event: { event: 'generating_opinions', data: { title: chapter.title } },
    })
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
    await emitProgress({
      idempotencyKey: `${scope}:opinions-ready`,
      event: { event: 'opinions_ready', data: { title: chapter.title } },
    })
    return {
      chapters: replaceChapter(state, state.currentChapterIndex, {
        coverageAttempts: attempts,
        coveragePoints: result.points,
      }),
    }
  }

  // 节点 write：生成当前章节正文，也承接轻审和全文审核后的重写。
  // reviewFeedback 告诉 Writer 为什么重写；成功后重置本轮计数并进入 light_review。
  const write: typeof WorkflowGraphState.Node = async (state) => {
    const chapter = currentChapter(state)
    if (!chapter) return failedUpdate(state, 'write', 'missing_chapter', 'Chapter index is invalid.')
    const attemptInPass = chapter.writeAttemptInPass + 1
    const writeAttempt = chapter.writeAttempts + 1
    const scope = `workflow:chapter:${state.currentChapterIndex}:write:attempt:${writeAttempt}`
    await emitProgress({
      idempotencyKey: `${scope}:started`,
      event: { event: 'writing_chapter', data: { title: chapter.title, token: '' } },
    })
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
            effectScope: `chapter:${state.currentChapterIndex}:write:attempt:${writeAttempt}`,
            onSearchProgress: async (progress) => {
              const searchScope = `${scope}:search:${progress.index}`
              await emitProgress(
                progress.phase === 'started'
                  ? {
                      idempotencyKey: `${searchScope}:started`,
                      event: {
                        event: 'searching',
                        data: {
                          title: chapter.title,
                          query: progress.query,
                          index: progress.index,
                        },
                      },
                    }
                  : {
                      idempotencyKey: `${searchScope}:finished`,
                      event: {
                        event: 'search_done',
                        data: {
                          title: chapter.title,
                          query: progress.query,
                          preview: progress.preview,
                          chars: progress.chars,
                        },
                      },
                    },
              )
            },
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
    // 当前模型接口返回完整章节而非 token stream，因此这里只持久化一个正文块。
    // 前端仍复用 writing_chapter 的累积逻辑，但不能将其描述为逐 token 输出。
    await emitProgress({
      idempotencyKey: `${scope}:content`,
      event: {
        event: 'writing_chapter',
        data: { title: chapter.title, token: result.content },
      },
    })
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

  // 节点 light_review：逐章快速审核。
  // 第一次失败会设置 needsRewrite 回到 write；再次失败则记录 warning 并继续下一章，
  // 防止单章质量问题让整条 Graph 无限循环。
  const lightReview: typeof WorkflowGraphState.Node = async (state) => {
    const chapter = currentChapter(state)
    if (!chapter) {
      return failedUpdate(state, 'review', 'missing_chapter', 'Chapter index is invalid.')
    }
    const attempts = chapter.lightReviewAttempts + 1
    const scope = `workflow:chapter:${state.currentChapterIndex}:review:write:${chapter.writeAttempts}:attempt:${attempts}`
    await emitProgress({
      idempotencyKey: `${scope}:started`,
      event: { event: 'reviewing_chapter', data: { title: chapter.title } },
    })
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
    await emitProgress({
      idempotencyKey: `${scope}:finished`,
      event: {
        event: 'chapter_done',
        data: {
          title: chapter.title,
          review: {
            passed: result.verdict === 'passed',
            feedback: result.feedback,
          },
        },
      },
    })
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

  // 节点 next_chapter：只移动章节游标。
  // 还有章节时回到 coverage；全部完成后进入 full_review。
  const nextChapter: typeof WorkflowGraphState.Node = (state) => ({
    currentChapterIndex: state.currentChapterIndex + 1,
  })

  // 节点 full_review：一次审核所有章节并将结果写回对应章节。
  // 全部通过则 export；首轮仍有失败章节则重写；第二轮仍失败则带 warning 导出。
  const fullReview: typeof WorkflowGraphState.Node = async (state) => {
    const attempts = state.fullReviewAttempts + 1
    const reviewRound = state.fullReviewRound + 1
    const scope = `workflow:full-review:round:${reviewRound}:attempt:${attempts}`
    await emitProgress({
      idempotencyKey: `workflow:stage:review:round:${reviewRound}`,
      event: { event: 'stage_update', data: { stage: 'review' } },
    })
    await emitProgress({
      idempotencyKey: `${scope}:started`,
      event: { event: 'reviewing_full', data: {} },
    })
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

    await emitProgress({
      idempotencyKey: `${scope}:finished`,
      event: {
        event: 'review_done',
        data: {
          results: normalized.map((result, index) => ({
            title: state.chapters[index]!.title,
            passed: result.verdict === 'passed',
            feedback: result.feedback,
          })),
        },
      },
    })

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
    await emitProgress({
      idempotencyKey: `workflow:stage:write:round:${round}`,
      event: { event: 'stage_update', data: { stage: 'write' } },
    })
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

  // 节点 export：纯计算地拼接最终 Markdown，并生成稳定的导出幂等键。
  // 它不直接写 articles 表；真正的文章、done 事件和终态由 Runner 事务提交。
  const exportArticle: typeof WorkflowGraphState.Node = async (state) => {
    await emitProgress({
      idempotencyKey: `workflow:stage:export:round:${state.fullReviewRound}`,
      event: { event: 'stage_update', data: { stage: 'export' } },
    })
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

  // 把上面定义的函数注册为具名节点，再用条件边显式编码重试、人工修改和审核重写。
  // 节点函数负责更新 State；条件边只读取更新后的 State，决定下一节点名称。
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

  // 注入 checkpointer 后，每个已提交节点都能形成可恢复点；没有 checkpointer 时只允许不含人工中断的临时执行。
  const compiled = builder.compile({ checkpointer: options.checkpointer })

  // 条件边包含有限循环，recursionLimit 是最后一道保险，防止未来改动意外形成死循环。
  const withRecursionLimit = <T extends { recursionLimit?: number } | undefined>(config: T) => ({
    ...config,
    recursionLimit: config?.recursionLimit ?? 100,
  })

  return {
    // 新任务入口：传入 createWorkflowState() 的结果，从 START → plan 开始。
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
    // 恢复入口：不创建新 State，直接让 LangGraph 从当前 thread 的 Checkpoint 继续。
    replay: (config: Parameters<typeof compiled.getState>[0]) =>
      compiled.invoke(null, withRecursionLimit(config)),
    // 读取当前 thread 的最新状态，主要用于诊断和测试，不推进 Graph。
    getState: (
      config: Parameters<typeof compiled.getState>[0],
      options?: Parameters<typeof compiled.getState>[1],
    ) => compiled.getState(config, options),
    // 读取该 thread 的 Checkpoint 历史，主要用于恢复验证和问题排查。
    getStateHistory: (
      config: Parameters<typeof compiled.getStateHistory>[0],
      options?: Parameters<typeof compiled.getStateHistory>[1],
    ) => compiled.getStateHistory(config, options),
  }
}

/**
 * 将人工回复转换成 LangGraph 恢复命令。
 *
 * 既接受 Graph 内部的显式 confirm/revise，也接受 Route Handler 的 ReplyRequest；
 * outline_review 节点恢复执行时，interrupt() 会收到这里写入的 resume 值。
 */
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
