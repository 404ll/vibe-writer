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
  // 这是单个 Graph 节点的有界业务重试，不是 BullMQ 投递重试，也不是
  // Worker 崩溃后的 Checkpoint 恢复。只对明确可重试的模型结果再尝试一次。
  return RETRYABLE_WRITER_REASONS.has(reason) && attempts < 2 ? 'retry' : 'terminal'
}

export function componentInconclusiveDecision(attempts: number): AttemptDecision {
  // Planner、Coverage、Reviewer 同样最多执行两次，防止条件边形成无界循环。
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
