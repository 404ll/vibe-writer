/**
 * 审稿：先做确定性字数闸门，再问模型质量判断。
 *
 * 字数超限直接 failed，不消耗审稿模型。模型 JSON 无法解析时是 inconclusive，
 * 与「质量不通过」分开，避免把协议失败当成文章写坏。计数规则对齐 Python 基线
 * （去空白后的码点长度 + 银行家舍入），否则评测会因 0.5 字差漂移。
 */
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

/** 与旧 Python 计数对齐：去掉空格和换行后按 Unicode 码点计「字」。 */
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
      // 单章允许超过分配字数 15%；再宽会让全文预算形同虚设。
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
      // 全文只放宽 10%，比单章更严，防止各章都顶到 115% 后总和失控。
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

    // results 必须与章节一一对应；缺项按 inconclusive，不能默认 passed。
    return input.chapters.map((_, index) => {
      const result = parsed.data.results[index]
      return result ? fromModelResult(result) : inconclusive('missing_model_result')
    })
  }
}
