import type { ReviewReport } from '@vibe-writer/agent-core'

export const MAX_REVIEW_ROUNDS = 2

export type ReviewRoute = 'export' | 'revise' | 'export_with_warnings'

/** evaluator-optimizer 只能有界返工；否则主观 Reviewer 可能让任务永远不终结。 */
export function routeAfterReview(
  report: ReviewReport,
  completedReviewRounds: number,
): ReviewRoute {
  if (report.verdict === 'approved') return 'export'
  return completedReviewRounds >= MAX_REVIEW_ROUNDS
    ? 'export_with_warnings'
    : 'revise'
}

export function reviewWarning(report: ReviewReport, round: number): string {
  const firstIssue = report.globalIssues[0]
    ?? report.localIssues[0]?.issue
    ?? report.summary
  return `第 ${round} 轮全文审核仍需修改：${firstIssue}`
}
