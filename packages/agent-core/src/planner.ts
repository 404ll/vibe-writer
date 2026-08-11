import type { TextModel } from '@vibe-writer/model-runtime'
import {
  buildOutlineRevisionUserPrompt,
  buildOutlineUserPrompt,
  OUTLINE_REVISION_SYSTEM,
  OUTLINE_SYSTEM,
} from './prompts'
import { PROMPT_VERSIONS } from './versions'

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

export function trimOutlineForBudget(chapters: string[], targetWords?: number): string[] {
  if (!targetWords || chapters.length === 0) return chapters
  const maxChapters =
    targetWords <= 1000 ? 3 : targetWords <= 2000 ? 4 : targetWords <= 4000 ? 5 : 6
  return chapters.length > maxChapters ? chapters.slice(0, maxChapters) : chapters
}

export class PlannerService {
  constructor(private readonly model: TextModel) {}

  async plan(input: { topic: string; targetWords?: number; signal?: AbortSignal; effectScope?: string }) {
    const response = await this.model.generate({
      operation: 'planner.plan',
      promptVersion: PROMPT_VERSIONS.planner,
      system: OUTLINE_SYSTEM,
      user: buildOutlineUserPrompt(input.topic, input.targetWords),
      maxTokens: 2048,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })

    return trimOutlineForBudget(parseOutline(response.text), input.targetWords)
  }

  async revise(input: {
    topic: string
    outline: string[]
    feedback: string
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
  }) {
    const response = await this.model.generate({
      operation: 'planner.revise',
      promptVersion: PROMPT_VERSIONS.outlineRevision,
      system: OUTLINE_REVISION_SYSTEM,
      user: buildOutlineRevisionUserPrompt(input),
      maxTokens: 2048,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })
    return trimOutlineForBudget(parseOutline(response.text), input.targetWords)
  }
}
