import { parseJsonObject, type TextModel } from '@vibe-writer/model-runtime'
import { z } from 'zod'
import {
  buildChapterReviewUserPrompt,
  buildFullReviewUserPrompt,
  CHAPTER_REVIEW_SYSTEM,
  FULL_REVIEW_SYSTEM,
  pythonRound,
} from './prompts'
import { PROMPT_VERSIONS } from './versions'

const ModelReviewResultSchema = z.object({
  passed: z.boolean(),
  feedback: z.string().default(''),
})

const FullReviewResponseSchema = z.object({
  results: z.array(ModelReviewResultSchema),
})

export type ReviewVerdict = 'passed' | 'failed' | 'inconclusive'
export type ReviewSource = 'deterministic' | 'model'

export type ReviewResult = {
  verdict: ReviewVerdict
  feedback: string
  source: ReviewSource
  reason?: 'word_budget_exceeded' | 'invalid_model_output' | 'missing_model_result'
}

export type ReviewChapter = {
  title: string
  content: string
}

export function countArticleChars(text: string): number {
  return Array.from(text.replaceAll(' ', '').replaceAll('\n', '')).length
}

function fromModelResult(result: z.infer<typeof ModelReviewResultSchema>): ReviewResult {
  return {
    verdict: result.passed ? 'passed' : 'failed',
    feedback: result.feedback,
    source: 'model',
  }
}

function inconclusive(reason: 'invalid_model_output' | 'missing_model_result'): ReviewResult {
  return {
    verdict: 'inconclusive',
    feedback: '审稿模型输出无法验证，需要重试或人工处理。',
    source: 'model',
    reason,
  }
}

export class ReviewerService {
  constructor(private readonly model: TextModel) {}

  async reviewChapter(input: {
    chapterTitle: string
    content: string
    outline: string
    chapterWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ReviewResult> {
    if (input.chapterWords) {
      const actual = countArticleChars(input.content)
      const hardMax = pythonRound(input.chapterWords * 1.15)
      if (actual > hardMax) {
        return {
          verdict: 'failed',
          feedback: `本章约 ${actual} 字，超过上限 ${input.chapterWords} 字（允许至 ${hardMax} 字）。请删减冗余表述，保留核心事实与机制说明。`,
          source: 'deterministic',
          reason: 'word_budget_exceeded',
        }
      }
    }

    const response = await this.model.generate({
      operation: 'reviewer.chapter',
      promptVersion: PROMPT_VERSIONS.chapterReviewer,
      system: CHAPTER_REVIEW_SYSTEM,
      user: buildChapterReviewUserPrompt(input),
      maxTokens: 512,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })
    const parsed = ModelReviewResultSchema.safeParse(parseJsonObject(response.text))
    return parsed.success ? fromModelResult(parsed.data) : inconclusive('invalid_model_output')
  }

  async reviewFull(input: {
    topic: string
    chapters: ReviewChapter[]
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ReviewResult[]> {
    const fullText = input.chapters
      .map((chapter) => `## ${chapter.title}\n${chapter.content}`)
      .join('\n\n')

    if (input.targetWords) {
      const total = countArticleChars(fullText)
      const hardMax = pythonRound(input.targetWords * 1.1)
      if (total > hardMax) {
        return input.chapters.map(() => ({
          verdict: 'failed',
          feedback: `全文约 ${total} 字，超过用户上限 ${input.targetWords} 字。请压缩各章，删除重复与煽情表述。`,
          source: 'deterministic',
          reason: 'word_budget_exceeded',
        }))
      }
    }

    const response = await this.model.generate({
      operation: 'reviewer.full',
      promptVersion: PROMPT_VERSIONS.fullReviewer,
      system: FULL_REVIEW_SYSTEM,
      user: buildFullReviewUserPrompt({
        topic: input.topic,
        fullText,
        targetWords: input.targetWords,
      }),
      maxTokens: 1024,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })
    const parsed = FullReviewResponseSchema.safeParse(parseJsonObject(response.text))
    if (!parsed.success) return input.chapters.map(() => inconclusive('invalid_model_output'))

    return input.chapters.map((_, index) => {
      const result = parsed.data.results[index]
      return result ? fromModelResult(result) : inconclusive('missing_model_result')
    })
  }
}
