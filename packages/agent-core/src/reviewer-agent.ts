import { parseJsonObject, type TextModel } from '@vibe-writer/model-runtime'
import { countArticleChars } from './reviewer'
import { buildReviewerAgentPrompt, REVIEWER_AGENT_SYSTEM, pythonRound } from './prompts'
import { PROMPT_VERSIONS } from './versions'
import {
  REVIEW_REPORT_VERSION,
  ReviewReportSchema,
  type EditorialDecision,
  type ReviewReport,
  type SourceNotebook,
  type WritingBrief,
} from './writing-artifacts'

export type ArticleReviewInput = {
  brief: WritingBrief
  approvedOutline: string[]
  editorialDecisions: EditorialDecision[]
  sources: SourceNotebook
  draft: string
  signal?: AbortSignal
  effectScope?: string
}

export type ArticleReviewResult =
  | { status: 'ready'; report: ReviewReport; source: 'deterministic' | 'model' }
  | { status: 'inconclusive'; reason: 'invalid_model_output' }

function markdownSections(draft: string): string[] {
  return draft
    .split('\n')
    .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
    .filter((title): title is string => Boolean(title))
}

/** 模型审稿前的硬闸：空稿、明显缺章和超长无需消耗一次 Reviewer 调用。 */
export function inspectDraftDeterministically(input: ArticleReviewInput): ReviewReport | null {
  const globalIssues: string[] = []
  const localIssues: ReviewReport['localIssues'] = []
  if (!input.draft.trim()) globalIssues.push('草稿为空，必须提交完整 Markdown 文章。')
  if (!/^#\s+\S/m.test(input.draft)) globalIssues.push('缺少文章一级标题。')

  const actualSections = markdownSections(input.draft)
  for (const title of input.approvedOutline) {
    if (!actualSections.some((heading) => heading.includes(title) || title.includes(heading))) {
      localIssues.push({
        section: title,
        issue: '确认大纲中的章节没有出现在草稿二级标题中。',
        suggestion: `补充「${title}」章节，并与前后章节建立承接。`,
      })
    }
  }
  if (input.brief.targetWords) {
    const actual = countArticleChars(input.draft)
    const hardMax = pythonRound(input.brief.targetWords * 1.1)
    if (actual > hardMax) {
      globalIssues.push(`全文约 ${actual} 字，超过 ${input.brief.targetWords} 字上限允许的 ${hardMax} 字硬闸。`)
    }
  }
  if (globalIssues.length === 0 && localIssues.length === 0) return null
  return ReviewReportSchema.parse({
    version: REVIEW_REPORT_VERSION,
    verdict: 'needs_revision',
    summary: '确定性结构或篇幅检查未通过。',
    globalIssues,
    localIssues,
  })
}

/** Reviewer 每轮都是独立调用，只看显式 artifacts，不接收 Writer 的 message history。 */
export class ReviewerAgentService {
  constructor(private readonly model: TextModel) {}

  async review(input: ArticleReviewInput): Promise<ArticleReviewResult> {
    const deterministic = inspectDraftDeterministically(input)
    if (deterministic) {
      return { status: 'ready', report: deterministic, source: 'deterministic' }
    }

    const response = await this.model.generate({
      operation: 'reviewer-agent.review',
      promptVersion: PROMPT_VERSIONS.reviewerAgent,
      system: REVIEWER_AGENT_SYSTEM,
      user: buildReviewerAgentPrompt(input),
      maxTokens: 2_048,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })
    const parsed = ReviewReportSchema.safeParse(parseJsonObject(response.text))
    return parsed.success
      ? { status: 'ready', report: parsed.data, source: 'model' }
      : { status: 'inconclusive', reason: 'invalid_model_output' }
  }
}
