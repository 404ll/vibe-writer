import type { JsonValue, ToolModelMessage } from '@vibe-writer/model-runtime'
import { z } from 'zod'
import type { ToolBudgetUsage } from './tool-loop'
import { ToolBudgetUsageSchema } from './writing-schemas'
import { writerStyleInstruction } from './writing-style'

export const WRITING_BRIEF_VERSION = 'writing-brief-v1'
export const EDITORIAL_DECISION_VERSION = 'editorial-decision-v1'
export const WRITER_SESSION_VERSION = 'writer-session-v1'
export const REVIEW_REPORT_VERSION = 'review-report-v1'
export const SOURCE_NOTEBOOK_VERSION = 'source-notebook-v1'

export const MAX_EDITORIAL_DECISIONS = 4
export const MAX_WRITER_MESSAGES = 64
export const MAX_SOURCE_NOTES = 24
export const MAX_WRITER_SESSION_CHARS = 600_000

const BoundedLineSchema = z.string().trim().min(1).max(500)

export const WritingBriefSchema = z.object({
  version: z.literal(WRITING_BRIEF_VERSION),
  topic: z.string().trim().min(1).max(500),
  style: z.string().trim().max(500),
  styleInstruction: z.string().trim().max(1_000),
  audience: z.string().trim().min(1).max(500),
  targetWords: z.number().int().positive().nullable(),
  acceptanceCriteria: z.array(BoundedLineSchema).min(1).max(8),
}).strict()

export const EditorialDecisionSchema = z.object({
  version: z.literal(EDITORIAL_DECISION_VERSION),
  sequence: z.number().int().positive(),
  source: z.enum(['outline_feedback', 'manual_outline']),
  instruction: z.string().trim().min(1).max(1_000),
  resultingOutline: z.array(BoundedLineSchema).min(1).max(6),
}).strict()

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]))

const WriterMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string().max(150_000) }).strict(),
      z.object({
        type: z.literal('tool_result'),
        toolCallId: z.string().min(1).max(500),
        content: z.string().max(40_000),
        isError: z.boolean(),
      }).strict(),
    ])).min(1).max(16),
  }).strict(),
  z.object({
    role: z.literal('assistant'),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string().max(150_000) }).strict(),
      z.object({
        type: z.literal('tool_call'),
        id: z.string().min(1).max(500),
        name: z.string().min(1).max(100),
        input: z.record(z.string(), JsonValueSchema),
      }).strict(),
    ])).min(1).max(16),
  }).strict(),
])

export const WriterSessionSchema = z.object({
  version: z.literal(WRITER_SESSION_VERSION),
  messages: z.array(WriterMessageSchema).max(MAX_WRITER_MESSAGES),
  budgetUsage: ToolBudgetUsageSchema,
}).strict().superRefine((session, context) => {
  // aggregate 预算比“每块上限”更重要：它同时保护模型上下文和 2 MiB checkpoint channel。
  if (JSON.stringify(session.messages).length > MAX_WRITER_SESSION_CHARS) {
    context.addIssue({
      code: 'custom',
      path: ['messages'],
      message: `Writer session exceeds ${MAX_WRITER_SESSION_CHARS} characters.`,
    })
  }
})

export const SourceNoteSchema = z.object({
  title: BoundedLineSchema,
  url: z.string().url().max(2_000),
  publishedAt: z.string().max(100).optional(),
  score: z.number().finite().optional(),
  evidence: z.string().trim().min(1).max(2_000).optional(),
}).strict()

export const SourceNotebookSchema = z.object({
  version: z.literal(SOURCE_NOTEBOOK_VERSION),
  sources: z.array(SourceNoteSchema).max(MAX_SOURCE_NOTES),
}).strict()

export const ReviewReportSchema = z.object({
  version: z.literal(REVIEW_REPORT_VERSION),
  verdict: z.enum(['approved', 'needs_revision']),
  summary: z.string().trim().min(1).max(1_500),
  globalIssues: z.array(z.string().trim().min(1).max(1_000)).max(8),
  localIssues: z.array(z.object({
    section: BoundedLineSchema,
    issue: z.string().trim().min(1).max(1_000),
    suggestion: z.string().trim().min(1).max(1_000),
  }).strict()).max(12),
}).strict().superRefine((report, context) => {
  if (
    report.verdict === 'approved'
    && (report.globalIssues.length > 0 || report.localIssues.length > 0)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['verdict'],
      message: 'Approved review reports cannot contain unresolved issues.',
    })
  }
  if (
    report.verdict === 'needs_revision'
    && report.globalIssues.length === 0
    && report.localIssues.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['verdict'],
      message: 'Revision reports must contain at least one actionable issue.',
    })
  }
})

export type WritingBrief = z.infer<typeof WritingBriefSchema>
export type EditorialDecision = z.infer<typeof EditorialDecisionSchema>
export type WriterSession = {
  version: typeof WRITER_SESSION_VERSION
  messages: ToolModelMessage[]
  budgetUsage: ToolBudgetUsage
}
export type SourceNote = z.infer<typeof SourceNoteSchema>
export type SourceNotebook = z.infer<typeof SourceNotebookSchema>
export type ReviewReport = z.infer<typeof ReviewReportSchema>

const STYLE_AUDIENCES: Record<string, string> = {
  技术博客: '有经验的开发者',
  科普: '对技术主题感兴趣的普通读者',
  教程: '希望跟随步骤完成实践的初学者',
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

export function buildWritingBrief(input: {
  topic: string
  style?: string
  targetWords?: number
}): WritingBrief {
  const style = (input.style ?? '').trim()
  const styleInstruction = compact(writerStyleInstruction(style), 1_000)
  return WritingBriefSchema.parse({
    version: WRITING_BRIEF_VERSION,
    topic: input.topic.trim(),
    style,
    styleInstruction,
    audience: STYLE_AUDIENCES[style] ?? '对该主题感兴趣的读者（用户未进一步指定）',
    targetWords: input.targetWords ?? null,
    acceptanceCriteria: [
      `全文围绕「${compact(input.topic, 400)}」形成一条连续论证线。`,
      '完整覆盖确认后的大纲，各章节之间有清晰承接且不重复堆砌。',
      '事实、案例和引用可区分；没有来源时不得编造出处。',
      ...(input.targetWords ? [`全文不超过 ${input.targetWords} 字。`] : []),
      ...(styleInstruction
        ? [compact(`从大纲措辞到正文转场持续遵守：${styleInstruction}`, 500)]
        : []),
    ],
  })
}

export function appendEditorialDecision(
  decisions: EditorialDecision[],
  input: Omit<EditorialDecision, 'version' | 'sequence'>,
): EditorialDecision[] {
  const decision = EditorialDecisionSchema.parse({
    ...input,
    version: EDITORIAL_DECISION_VERSION,
    sequence: (decisions.at(-1)?.sequence ?? 0) + 1,
    instruction: compact(input.instruction, 1_000),
  })
  return [...decisions, decision].slice(-MAX_EDITORIAL_DECISIONS)
}

export function emptyWriterSession(): WriterSession {
  return WriterSessionSchema.parse({
    version: WRITER_SESSION_VERSION,
    messages: [],
    budgetUsage: { totalCalls: 0, callsByTool: {} },
  }) as WriterSession
}

export function emptySourceNotebook(): SourceNotebook {
  return { version: SOURCE_NOTEBOOK_VERSION, sources: [] }
}

export function mergeSourceNotebook(
  notebook: SourceNotebook,
  incoming: SourceNote[],
): SourceNotebook {
  const byUrl = new Map(notebook.sources.map((source) => [source.url, source]))
  for (const source of incoming) byUrl.set(source.url, SourceNoteSchema.parse(source))
  return SourceNotebookSchema.parse({
    version: SOURCE_NOTEBOOK_VERSION,
    sources: [...byUrl.values()].slice(-MAX_SOURCE_NOTES),
  })
}

export function formatWritingBrief(brief: WritingBrief): string {
  return [
    `主题：${brief.topic}`,
    `目标读者：${brief.audience}`,
    `风格：${brief.style || '未指定'}`,
    ...(brief.styleInstruction ? [`风格执行：${brief.styleInstruction}`] : []),
    `篇幅：${brief.targetWords ? `不超过 ${brief.targetWords} 字` : '不限制'}`,
    '验收标准：',
    ...brief.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].join('\n')
}

export function formatEditorialDecisions(decisions: EditorialDecision[]): string {
  return decisions.length === 0
    ? '暂无额外编辑决策。'
    : decisions.map((decision) =>
      `- 决策 ${decision.sequence}：${decision.instruction}（形成大纲：${decision.resultingOutline.join(' / ')}）`,
    ).join('\n')
}

export function formatReviewReport(report: ReviewReport): string {
  return [
    `结论：${report.verdict}`,
    `摘要：${report.summary}`,
    ...(report.globalIssues.length > 0
      ? ['全局问题：', ...report.globalIssues.map((issue) => `- ${issue}`)]
      : []),
    ...(report.localIssues.length > 0
      ? ['局部问题：', ...report.localIssues.map((issue) =>
        `- ${issue.section}：${issue.issue}；建议：${issue.suggestion}`,
      )]
      : []),
  ].join('\n')
}
