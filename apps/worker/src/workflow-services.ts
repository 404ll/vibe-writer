import {
  PlannerService,
  ResearchService,
  ReviewerAgentService,
  WriterAgentService,
  type SearchProvider,
} from '@vibe-writer/agent-core'
import type { TextModel, ToolModel } from '@vibe-writer/model-runtime'
import type { WriterReviewerServices } from '@vibe-writer/workflow-runtime'

export type WorkflowModel = TextModel & ToolModel

export function createWorkflowServices(
  model: WorkflowModel,
  searchProvider?: SearchProvider,
): WriterReviewerServices {
  const planner = new PlannerService(model)
  const reviewer = new ReviewerAgentService(model)
  const research = searchProvider ? new ResearchService(searchProvider, model) : null

  return {
    plan: (input) => planner.plan(input),
    reviseOutline: (input) => planner.revise({
      topic: input.brief.topic,
      brief: input.brief,
      outline: input.outline,
      feedback: input.feedback,
      targetWords: input.brief.targetWords ?? undefined,
      editorialDecisions: input.editorialDecisions,
      signal: input.signal,
      effectScope: input.effectScope,
    }),
    writeArticle: (input) => {
      let searchIndex = 0
      return new WriterAgentService(model, {
        ...(research
          ? {
              // Writer 的 search tool 在章节生成过程中才知道真实 query。
              // 在这里投影开始/完成事件，避免用 coverage 的搜索建议冒充真实调用。
              research: async (query, signal, effectScope) => {
                const index = searchIndex + 1
                searchIndex = index
                await input.onSearchProgress?.({ phase: 'started', query, index })
                const result = await research.research({ query, signal, effectScope })
                const text = result.status === 'ready' ? result.summary : ''
                await input.onSearchProgress?.({
                  phase: 'finished',
                  query,
                  index,
                  preview: text.slice(0, 160),
                  chars: text.length,
                })
                return result
              },
            }
          : {}),
      }).write(input)
    },
    reviewArticle: (input) => reviewer.review(input),
  }
}
