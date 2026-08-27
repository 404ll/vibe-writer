import {
  CoveragePlannerService,
  PlannerService,
  ResearchService,
  ReviewerService,
  WriterService,
  type SearchProvider,
} from '@vibe-writer/agent-core'
import type { TextModel, ToolModel } from '@vibe-writer/model-runtime'
import type { WorkflowServices } from '@vibe-writer/workflow-runtime'

export type WorkflowModel = TextModel & ToolModel

export function createWorkflowServices(
  model: WorkflowModel,
  searchProvider?: SearchProvider,
): WorkflowServices {
  const planner = new PlannerService(model)
  const coverage = new CoveragePlannerService(model)
  const reviewer = new ReviewerService(model)
  const research = searchProvider ? new ResearchService(searchProvider, model) : null

  return {
    plan: (input) => planner.plan(input),
    reviseOutline: (input) => planner.revise(input),
    planCoverage: (input) => coverage.plan(input),
    writeChapter: (input) => {
      let searchIndex = 0
      return new WriterService(model, {
        style: input.style,
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
    reviewChapter: (input) => reviewer.reviewChapter(input),
    reviewFull: (input) => reviewer.reviewFull(input),
  }
}
