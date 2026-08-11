import type { ToolLoopInconclusiveReason } from '@vibe-writer/agent-core'
import type { WorkflowFailure } from './state'

export type AttemptDecision = 'retry' | 'terminal'
export type FullReviewDecision = 'export' | 'rewrite' | 'export_with_warnings'

const RETRYABLE_WRITER_REASONS: ReadonlySet<ToolLoopInconclusiveReason> = new Set([
  'invalid_model_response',
  'empty_final_text',
  'max_tokens',
  'pause_turn',
])

export function writerInconclusiveDecision(
  reason: ToolLoopInconclusiveReason,
  attempts: number,
): AttemptDecision {
  return RETRYABLE_WRITER_REASONS.has(reason) && attempts < 2 ? 'retry' : 'terminal'
}

export function componentInconclusiveDecision(attempts: number): AttemptDecision {
  return attempts < 2 ? 'retry' : 'terminal'
}

export function fullReviewDecision(
  failedChapters: number,
  completedRound: number,
): FullReviewDecision {
  if (failedChapters === 0) return 'export'
  return completedRound >= 2 ? 'export_with_warnings' : 'rewrite'
}

export function terminalFailure(input: Omit<WorkflowFailure, 'retryable'>): WorkflowFailure {
  return { ...input, retryable: false }
}

export function chapterWords(targetWords: number | null, chapterCount: number): number | undefined {
  if (targetWords === null) return undefined
  return Math.max(80, Math.round(targetWords / Math.max(chapterCount, 1)))
}
