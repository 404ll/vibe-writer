import {
  EditorialDecisionSchema,
  ReviewReportSchema,
  SourceNotebookSchema,
  WritingBriefSchema,
  WriterSessionSchema,
  buildWritingBrief,
  emptySourceNotebook,
  emptyWriterSession,
} from '@vibe-writer/agent-core'
import { z } from 'zod'
import {
  ExecutionConfigSchema,
  ExportIntentSchema,
  WorkflowFailureSchema,
} from './state'

export const WRITER_REVIEWER_WORKFLOW_VERSION = 'writer-reviewer-graph-v2-2026-09-03'

/**
 * v2 checkpoint 只保存可恢复的 provider-neutral artifacts：brief、正常消息、工具结果、
 * 草稿和 ReviewReport。SDK client、连接对象和隐藏推理绝不能进入持久化状态。
 */
export const WriterReviewerWorkflowStateSchema = z.object({
  workflowVersion: z.literal(WRITER_REVIEWER_WORKFLOW_VERSION),
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
  writingBrief: WritingBriefSchema,
  outline: z.array(z.string().trim().min(1)).max(6),
  approvedOutline: z.array(z.string().trim().min(1)).max(6),
  outlineAttempts: z.number().int().nonnegative(),
  outlineRevisionRound: z.number().int().nonnegative(),
  outlineRevisionAttempts: z.number().int().nonnegative(),
  outlineAction: z.enum(['none', 'confirm', 'revise']),
  outlineFeedback: z.string().max(2_000),
  editorialDecisions: z.array(EditorialDecisionSchema).max(4),
  writerSession: WriterSessionSchema,
  writerAttemptInRound: z.number().int().nonnegative(),
  partialDraft: z.string().max(150_000),
  draft: z.string().max(150_000),
  sourceNotebook: SourceNotebookSchema,
  reviewReport: ReviewReportSchema.nullable(),
  reviewRound: z.number().int().nonnegative(),
  reviewAttempts: z.number().int().nonnegative(),
  qualityWarnings: z.array(z.string().max(2_000)).max(8),
  failure: WorkflowFailureSchema.nullable(),
  finalContent: z.string().max(150_000),
  exportIntent: ExportIntentSchema.nullable(),
}).superRefine((state, context) => {
  if (state.executionConfig.graphVersion !== state.workflowVersion) {
    context.addIssue({
      code: 'custom', path: ['executionConfig', 'graphVersion'],
      message: 'Execution graphVersion must match workflowVersion.',
    })
  }
  if (
    state.writingBrief.topic !== state.topic
    || state.writingBrief.style !== state.style
    || state.writingBrief.targetWords !== state.targetWords
  ) {
    context.addIssue({
      code: 'custom', path: ['writingBrief'],
      message: 'Writing brief must remain bound to the immutable job input.',
    })
  }
  if (['write', 'review', 'export', 'completed'].includes(state.phase) && state.approvedOutline.length === 0) {
    context.addIssue({
      code: 'custom', path: ['approvedOutline'],
      message: 'Writing and later phases require an approved outline.',
    })
  }
  if (state.phase === 'completed' && (!state.finalContent.trim() || !state.exportIntent)) {
    context.addIssue({
      code: 'custom', path: ['phase'],
      message: 'Completed workflow state requires finalContent and exportIntent.',
    })
  }
  if (
    state.phase === 'completed'
    && (state.draft !== state.finalContent || state.exportIntent?.markdown !== state.finalContent)
  ) {
    context.addIssue({
      code: 'custom', path: ['finalContent'],
      message: 'Completed draft, finalContent and exportIntent markdown must be identical.',
    })
  }
  if (state.phase === 'failed' && !state.failure) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Failed state requires failure.' })
  }
  if (state.phase !== 'failed' && state.failure) {
    context.addIssue({ code: 'custom', path: ['failure'], message: 'Only failed state may contain failure.' })
  }
})

export type WriterReviewerWorkflowState = z.infer<typeof WriterReviewerWorkflowStateSchema>

export function createWriterReviewerWorkflowState(input: {
  jobId: string
  topic: string
  style?: string
  targetWords?: number
  interventionOnOutline?: boolean
  executionConfig?: z.input<typeof ExecutionConfigSchema>
}): WriterReviewerWorkflowState {
  const brief = buildWritingBrief(input)
  return WriterReviewerWorkflowStateSchema.parse({
    workflowVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
    executionConfig: input.executionConfig ?? {
      id: 'prototype-unbound',
      graphVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
      promptSetVersion: 'prototype-unbound',
      modelProfileId: 'prototype-unbound',
      toolsetVersion: 'prototype-unbound',
      codeRevision: null,
    },
    jobId: input.jobId,
    topic: brief.topic,
    style: brief.style,
    targetWords: brief.targetWords,
    interventionOnOutline: input.interventionOnOutline ?? true,
    phase: 'plan',
    writingBrief: brief,
    outline: [],
    approvedOutline: [],
    outlineAttempts: 0,
    outlineRevisionRound: 0,
    outlineRevisionAttempts: 0,
    outlineAction: 'none',
    outlineFeedback: '',
    editorialDecisions: [],
    writerSession: emptyWriterSession(),
    writerAttemptInRound: 0,
    partialDraft: '',
    draft: '',
    sourceNotebook: emptySourceNotebook(),
    reviewReport: null,
    reviewRound: 0,
    reviewAttempts: 0,
    qualityWarnings: [],
    failure: null,
    finalContent: '',
    exportIntent: null,
  })
}
