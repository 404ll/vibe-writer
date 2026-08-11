import { parseJsonObject, type TextModel } from '@vibe-writer/model-runtime'
import { z } from 'zod'
import { buildCoverageUserPrompt, COVERAGE_SYSTEM } from './prompts'
import { PROMPT_VERSIONS } from './versions'

const CoverageOutputSchema = z
  .object({
    opinions: z.array(z.string().trim().min(1)).min(1).max(3),
    search_queries: z.array(z.string().trim().min(1)).min(1).max(3),
  })
  .refine((output) => output.opinions.length === output.search_queries.length, {
    message: 'Every coverage point must have exactly one search query',
  })

export type CoveragePoint = {
  text: string
  searchQuery: string
}

export type CoveragePlanResult =
  | { status: 'ready'; points: CoveragePoint[] }
  | { status: 'inconclusive'; points: []; reason: 'invalid_model_output' }

export function parseCoveragePlan(raw: string): CoveragePlanResult {
  const parsed = CoverageOutputSchema.safeParse(parseJsonObject(raw))
  if (!parsed.success) {
    return { status: 'inconclusive', points: [], reason: 'invalid_model_output' }
  }

  return {
    status: 'ready',
    points: parsed.data.opinions.map((text, index) => ({
      text,
      searchQuery: parsed.data.search_queries[index] as string,
    })),
  }
}

export function formatCoveragePoints(points: CoveragePoint[]): string {
  return points.map((point) => `- ${point.text}`).join('\n')
}

export class CoveragePlannerService {
  constructor(private readonly model: TextModel) {}

  async plan(input: {
    topic: string
    outline: string
    chapterTitle: string
    signal?: AbortSignal
    effectScope?: string
  }): Promise<CoveragePlanResult> {
    const response = await this.model.generate({
      operation: 'coverage-planner.plan',
      promptVersion: PROMPT_VERSIONS.coveragePlanner,
      system: COVERAGE_SYSTEM,
      user: buildCoverageUserPrompt(input),
      maxTokens: 1024,
      signal: input.signal,
      metadata: input.effectScope ? { effectScope: input.effectScope } : undefined,
    })

    return parseCoveragePlan(response.text)
  }
}
