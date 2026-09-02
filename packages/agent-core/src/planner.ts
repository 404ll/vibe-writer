/**
 * 大纲规划器。
 *
 * 模型只负责生成编号章节标题；字数预算裁剪和解析失败都在本文件用确定性规则处理，
 * 避免把模型闲聊或超长大纲直接送进后续写作节点。本层不持有 interrupt：人工确认大纲
 * 是工作流节点的职责。
 */
import type { TextModel } from '@vibe-writer/model-runtime'
import {
  buildOutlineRevisionUserPrompt,
  buildOutlineUserPrompt,
  OUTLINE_REVISION_SYSTEM,
  OUTLINE_SYSTEM,
} from './prompts'
import { PROMPT_VERSIONS } from './versions'
import type { EditorialDecision, WritingBrief } from './writing-artifacts'

/** 只接受「数字编号 + 标题」行，丢掉解释性前后文，防止模型寒暄变成章节。 */
export function parseOutline(raw: string): string[] {
  const chapters: string[] = []
  for (const rawLine of raw.trim().split('\n')) {
    let line = rawLine.trim()
    if (!line || !/^\p{N}/u.test(line)) continue

    const dotIndex = line.indexOf('.')
    const chineseSeparatorIndex = line.indexOf('、')
    if (dotIndex >= 0) line = line.slice(dotIndex + 1).trim()
    else if (chineseSeparatorIndex >= 0) line = line.slice(chineseSeparatorIndex + 1).trim()
    if (line) chapters.push(line)
  }
  return chapters
}

/** 章节数是全文预算的第一道硬闸；后续 Writer/Reviewer 再按字数收口。 */
export function trimOutlineForBudget(chapters: string[], targetWords?: number): string[] {
  if (!targetWords || chapters.length === 0) return chapters
  const maxChapters =
    targetWords <= 1000 ? 3 : targetWords <= 2000 ? 4 : targetWords <= 4000 ? 5 : 6
  return chapters.length > maxChapters ? chapters.slice(0, maxChapters) : chapters
}

export class PlannerService {
  constructor(private readonly model: TextModel) {}

  /** 首次规划。`effectScope` 只传给模型 metadata，供外层 fenced 账本关联，不改变大纲语义。 */
  async plan(input: {
    topic?: string
    targetWords?: number
    brief?: WritingBrief
    signal?: AbortSignal
    effectScope?: string
  }) {
    const topic = input.brief?.topic ?? input.topic ?? ''
    const targetWords = input.brief?.targetWords ?? input.targetWords
    const response = await this.model.generate({
      operation: 'planner.plan',
      promptVersion: PROMPT_VERSIONS.planner,
      system: OUTLINE_SYSTEM,
      user: input.brief
        ? buildOutlineUserPrompt(input.brief)
        : buildOutlineUserPrompt(topic, targetWords ?? undefined),
      maxTokens: 2048,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })

    return trimOutlineForBudget(parseOutline(response.text), targetWords ?? undefined)
  }

  /** 按用户反馈改大纲；输出仍是完整大纲，不是 diff。 */
  async revise(input: {
    topic: string
    outline: string[]
    feedback: string
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
    brief?: WritingBrief
    editorialDecisions?: EditorialDecision[]
  }) {
    const response = await this.model.generate({
      operation: 'planner.revise',
      promptVersion: PROMPT_VERSIONS.outlineRevision,
      system: OUTLINE_REVISION_SYSTEM,
      user: buildOutlineRevisionUserPrompt({
        ...input,
        editorialDecisions: input.editorialDecisions ?? [],
      }),
      maxTokens: 2048,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })
    return trimOutlineForBudget(
      parseOutline(response.text),
      input.brief?.targetWords ?? input.targetWords,
    )
  }
}
