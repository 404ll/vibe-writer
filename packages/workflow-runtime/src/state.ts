import type { CoveragePoint, ToolBudgetUsage } from '@vibe-writer/agent-core'
import { z } from 'zod'

// Checkpoint 会长期保存工作流状态，因此恢复时必须知道它对应哪一版 Graph。
// 版本不匹配时不能直接拿旧状态驱动新流程，否则节点或字段语义可能已经变化。
export const WORKFLOW_VERSION = 'writer-graph-v1-target-2026-08-07'

//运行配置记录
export const ExecutionConfigSchema = z.object({
  id: z.string().min(1),
  graphVersion: z.string().min(1),
  promptSetVersion: z.string().min(1),
  modelProfileId: z.string().min(1),
  toolsetVersion: z.string().min(1),
  codeRevision: z.string().min(1).nullable(),
})

// 工具调用使用情况
export const ToolBudgetUsageSchema = z
  .object({
    totalCalls: z.number().int().nonnegative(),
    callsByTool: z.record(z.string(), z.number().int().nonnegative()),
  })
  .superRefine((usage, context) => {
    const attributedCalls = Object.values(usage.callsByTool).reduce(
      (total, calls) => total + calls,
      0,
    )
    if (attributedCalls > usage.totalCalls) {
      context.addIssue({
        code: 'custom',
        path: ['callsByTool'],
        message: 'Attributed tool calls cannot exceed totalCalls.',
      })
    }
  })

// 覆盖点
export const CoveragePointSchema = z.object({
  text: z.string().trim().min(1),
  searchQuery: z.string().trim().min(1),
})

// 工作流失败信息
export const WorkflowFailureSchema = z.object({
  stage: z.enum(['plan', 'outline_review', 'coverage', 'write', 'review', 'export']),
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  chapterIndex: z.number().int().nonnegative().optional(),
})

// 单章工作流状态
export const ChapterWorkflowStateSchema = z.object({
  title: z.string().trim().min(1),
  content: z.string(),
  coveragePoints: z.array(CoveragePointSchema),
  coverageAttempts: z.number().int().nonnegative(),
  writeAttempts: z.number().int().nonnegative(),
  writeAttemptInPass: z.number().int().nonnegative(),
  lightReviewAttempts: z.number().int().nonnegative(),
  lightRewriteCount: z.number().int().nonnegative(),
  fullRewriteCount: z.number().int().nonnegative(),
  lightReviewStatus: z.enum(['pending', 'passed', 'failed']),
  needsRewrite: z.boolean(),
  reviewStatus: z.enum(['pending', 'passed', 'failed']),
  reviewFeedback: z.string(),
  toolBudgetUsage: ToolBudgetUsageSchema,
})

export const ExportIntentSchema = z.object({
  idempotencyKey: z.string().min(1),
  markdown: z.string().min(1),
})

// 这是 LangGraph 节点之间唯一共享的持久化状态。只放可序列化的业务数据，
// 不把数据库连接、模型客户端或 SDK 对象写进 Checkpoint。
export const WorkflowStateSchema = z.object({
  workflowVersion: z.string().min(1),
  executionConfig: ExecutionConfigSchema,
  jobId: z.string().min(1),
  topic: z.string().trim().min(1),
  style: z.string(),
  targetWords: z.number().int().positive().nullable(),
  interventionOnOutline: z.boolean(),
  phase: z.enum([
    'plan',
    'outline_review',
    'revise_outline',
    'write',
    'review',
    'export',
    'completed',
    'failed',
  ]),
  outline: z.array(z.string().trim().min(1)).max(6),
  outlineAttempts: z.number().int().nonnegative(),
  outlineRevisionCount: z.number().int().nonnegative(),
  outlineRevisionAttempts: z.number().int().nonnegative(),
  outlineAction: z.enum(['none', 'confirm', 'revise']),
  outlineFeedback: z.string(),
  chapters: z.array(ChapterWorkflowStateSchema),
  currentChapterIndex: z.number().int().nonnegative(),
  fullReviewRound: z.number().int().nonnegative(),
  fullReviewAttempts: z.number().int().nonnegative(),
  qualityWarnings: z.array(z.string()),
  failure: WorkflowFailureSchema.nullable(),
  finalContent: z.string(),
  exportIntent: ExportIntentSchema.nullable(),
  //自定义联合校验
}).superRefine((state, context) => {
  if (state.executionConfig.graphVersion !== state.workflowVersion) {
    context.addIssue({
      code: 'custom',
      path: ['executionConfig', 'graphVersion'],
      message: 'Execution graphVersion must match workflowVersion.',
    })
  }
  if (state.currentChapterIndex > state.chapters.length) {
    context.addIssue({
      code: 'custom',
      path: ['currentChapterIndex'],
      message: 'currentChapterIndex cannot exceed the chapter count.',
    })
  }
  if (state.phase === 'completed' && (!state.finalContent.trim() || !state.exportIntent)) {
    context.addIssue({
      code: 'custom',
      path: ['phase'],
      message: 'Completed workflow state requires finalContent and exportIntent.',
    })
  }
  if (
    state.phase === 'completed' &&
    state.exportIntent &&
    state.exportIntent.markdown !== state.finalContent
  ) {
    context.addIssue({
      code: 'custom',
      path: ['exportIntent', 'markdown'],
      message: 'Export markdown must equal finalContent.',
    })
  }
  if (state.phase === 'failed' && !state.failure) {
    context.addIssue({
      code: 'custom',
      path: ['failure'],
      message: 'Failed workflow state requires failure details.',
    })
  }
  if (state.phase !== 'failed' && state.failure) {
    context.addIssue({
      code: 'custom',
      path: ['failure'],
      message: 'Only failed workflow state may contain failure details.',
    })
  }
})

export type WorkflowState = z.infer<typeof WorkflowStateSchema>
export type ChapterWorkflowState = z.infer<typeof ChapterWorkflowStateSchema>
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>

export function freshToolBudget(): ToolBudgetUsage {
  return { totalCalls: 0, callsByTool: {} }
}

export function createChapterState(title: string): ChapterWorkflowState {
  return {
    title,
    content: '',
    coveragePoints: [] satisfies CoveragePoint[],
    coverageAttempts: 0,
    writeAttempts: 0,
    writeAttemptInPass: 0,
    lightReviewAttempts: 0,
    lightRewriteCount: 0,
    fullRewriteCount: 0,
    lightReviewStatus: 'pending',
    needsRewrite: false,
    reviewStatus: 'pending',
    reviewFeedback: '',
    toolBudgetUsage: freshToolBudget(),
  }
}

export function createWorkflowState(input: {
  jobId: string
  topic: string
  style?: string
  targetWords?: number
  interventionOnOutline?: boolean
  executionConfig?: z.input<typeof ExecutionConfigSchema>
}): WorkflowState {
  // 只有全新任务会创建初始 State；接管、队列重投和人工回复都应读取已提交的
  // Checkpoint，避免从 plan 开始重复调用模型。
  return WorkflowStateSchema.parse({
    workflowVersion: WORKFLOW_VERSION,
    executionConfig: input.executionConfig ?? {
      id: 'prototype-unbound',
      graphVersion: WORKFLOW_VERSION,
      promptSetVersion: 'prototype-unbound',
      modelProfileId: 'prototype-unbound',
      toolsetVersion: 'prototype-unbound',
      codeRevision: null,
    },
    jobId: input.jobId,
    topic: input.topic,
    style: input.style ?? '',
    targetWords: input.targetWords ?? null,
    interventionOnOutline: input.interventionOnOutline ?? true,
    phase: 'plan',
    outline: [],
    outlineAttempts: 0,
    outlineRevisionCount: 0,
    outlineRevisionAttempts: 0,
    outlineAction: 'none',
    outlineFeedback: '',
    chapters: [],
    currentChapterIndex: 0,
    fullReviewRound: 0,
    fullReviewAttempts: 0,
    qualityWarnings: [],
    failure: null,
    finalContent: '',
    exportIntent: null,
  })
}

export function renderMarkdown(topic: string, chapters: ChapterWorkflowState[]): string {
  return [`# ${topic}`, ...chapters.map((chapter) => `## ${chapter.title}\n${chapter.content}`)]
    .join('\n\n')
    .trim()
}
