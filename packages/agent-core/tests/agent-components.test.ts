import { readFileSync } from 'node:fs'
import { AgentComponentFixtureSchema } from '@vibe-writer/contracts/agent-component-fixtures'
import {
  parseJsonObject,
  type TextModel,
  type TextModelRequest,
  type TextModelResponse,
} from '@vibe-writer/model-runtime'
import { describe, expect, it } from 'vitest'
import { parseOutline, PlannerService, trimOutlineForBudget } from '../src/planner'
import { pythonRound } from '../src/prompts'
import { countArticleChars, ReviewerService } from '../src/reviewer'
import { PROMPT_VERSIONS } from '../src/versions'

const fixture = AgentComponentFixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../contracts/fixtures/agent-component-baseline.json', import.meta.url),
      'utf8',
    ),
  ),
)

class ScriptedTextModel implements TextModel {
  readonly requests: TextModelRequest[] = []

  constructor(private readonly responses: string[]) {}

  async generate(request: TextModelRequest): Promise<TextModelResponse> {
    this.requests.push(request)
    const text = this.responses.shift()
    if (text === undefined) throw new Error(`No scripted response for ${request.operation}`)
    return {
      text,
      provider: 'scripted',
      model: 'fixture-model',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    }
  }
}

describe('shared Python compatibility baseline', () => {
  it.each(fixture.planner_outline_cases)('parses planner case $id', (testCase) => {
    expect(parseOutline(testCase.raw)).toEqual(testCase.expected_chapters)
  })

  it.each(fixture.planner_trim_cases)('trims planner case $id', (testCase) => {
    expect(trimOutlineForBudget(testCase.chapters, testCase.target_words)).toEqual(
      testCase.expected_chapters,
    )
  })

  it.each(fixture.json_object_cases)('parses JSON case $id', (testCase) => {
    expect(parseJsonObject(testCase.raw)).toEqual(testCase.expected)
  })
})

describe('PlannerService', () => {
  it('uses the model port with operation and prompt version metadata', async () => {
    const model = new ScriptedTextModel(['1. 一\n2. 二\n3. 三\n4. 四'])
    const planner = new PlannerService(model)
    const controller = new AbortController()

    await expect(
      planner.plan({ topic: '测试主题', targetWords: 1000, signal: controller.signal }),
    ).resolves.toEqual(['一', '二', '三'])
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]).toMatchObject({
      operation: 'planner.plan',
      promptVersion: PROMPT_VERSIONS.planner,
      maxTokens: 2048,
      signal: controller.signal,
    })
    expect(model.requests[0]?.user).toContain('全文严格不超过 1000 字')
  })

  it('uses a separately versioned prompt for outline revision', async () => {
    const model = new ScriptedTextModel(['1. 新第一章\n2. 新第二章'])
    const planner = new PlannerService(model)
    await expect(planner.revise({
      topic: '测试主题', outline: ['旧章节'], feedback: '拆成两章', targetWords: 1000,
    })).resolves.toEqual(['新第一章', '新第二章'])
    expect(model.requests[0]).toMatchObject({
      operation: 'planner.revise', promptVersion: PROMPT_VERSIONS.outlineRevision,
    })
    expect(model.requests[0]?.user).toContain('用户反馈：拆成两章')
  })
})

describe('ReviewerService target behavior', () => {
  it('matches Python character and rounding semantics at migration boundaries', () => {
    expect(countArticleChars('中 😀\n文')).toBe(3)
    expect(pythonRound(34.5)).toBe(34)
    expect(pythonRound(35.5)).toBe(36)
    expect(pythonRound(57.49999999999999)).toBe(57)
  })

  it.each(fixture.reviewer_output_cases)(
    'maps $id to explicit target verdicts',
    async (testCase) => {
      const model = new ScriptedTextModel([testCase.raw])
      const reviewer = new ReviewerService(model)
      const chapters = Array.from({ length: testCase.chapter_count }, (_, index) => ({
        title: `章节 ${index + 1}`,
        content: `内容 ${index + 1}`,
      }))

      const results =
        testCase.scope === 'chapter'
          ? [
              await reviewer.reviewChapter({
                chapterTitle: chapters[0]?.title ?? '章节 1',
                content: chapters[0]?.content ?? '内容 1',
                outline: '1. 章节 1',
              }),
            ]
          : await reviewer.reviewFull({ topic: '测试主题', chapters })

      expect(results.map((result) => result.verdict)).toEqual(testCase.target_verdicts)
      expect(model.requests[0]).toMatchObject({
        operation: testCase.scope === 'chapter' ? 'reviewer.chapter' : 'reviewer.full',
        maxTokens: 8192,
        promptVersion:
          testCase.scope === 'chapter'
            ? PROMPT_VERSIONS.chapterReviewer
            : PROMPT_VERSIONS.fullReviewer,
      })
    },
  )

  it('fails deterministically before calling the model when a chapter exceeds budget', async () => {
    const model = new ScriptedTextModel([])
    const reviewer = new ReviewerService(model)
    const result = await reviewer.reviewChapter({
      chapterTitle: '过长章节',
      content: '字'.repeat(13),
      outline: '1. 过长章节',
      chapterWords: 10,
    })

    expect(result).toMatchObject({
      verdict: 'failed',
      source: 'deterministic',
      reason: 'word_budget_exceeded',
    })
    expect(model.requests).toHaveLength(0)
  })

  it('marks every chapter failed before model evaluation when the article exceeds budget', async () => {
    const model = new ScriptedTextModel([])
    const reviewer = new ReviewerService(model)
    const results = await reviewer.reviewFull({
      topic: '短文',
      chapters: [{ title: '章节', content: '字'.repeat(30) }],
      targetWords: 10,
    })

    expect(results.map((result) => result.verdict)).toEqual(['failed'])
    expect(results[0]?.source).toBe('deterministic')
    expect(model.requests).toHaveLength(0)
  })
})
