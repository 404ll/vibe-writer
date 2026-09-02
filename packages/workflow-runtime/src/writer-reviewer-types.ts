import type {
  ArticleReviewResult,
  EditorialDecision,
  SourceNotebook,
  WriterAgentResult,
  WriterSession,
  WritingBrief,
} from '@vibe-writer/agent-core'
import type { WorkflowSearchProgress } from './types'

export type WriterReviewerServices = {
  plan(input: {
    brief: WritingBrief
    signal?: AbortSignal
    effectScope?: string
  }): Promise<string[]>
  reviseOutline(input: {
    brief: WritingBrief
    outline: string[]
    feedback: string
    editorialDecisions: EditorialDecision[]
    signal?: AbortSignal
    effectScope?: string
  }): Promise<string[]>
  writeArticle(input: {
    brief: WritingBrief
    approvedOutline: string[]
    editorialDecisions: EditorialDecision[]
    session: WriterSession
    reviewReport: import('@vibe-writer/agent-core').ReviewReport | null
    continuationPrefix?: string
    signal?: AbortSignal
    effectScope?: string
    onSearchProgress?: (progress: WorkflowSearchProgress) => Promise<void>
  }): Promise<WriterAgentResult>
  reviewArticle(input: {
    brief: WritingBrief
    approvedOutline: string[]
    editorialDecisions: EditorialDecision[]
    sources: SourceNotebook
    draft: string
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ArticleReviewResult>
}
