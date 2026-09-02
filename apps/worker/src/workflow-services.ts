import {
  CoveragePlannerService,
  PlannerService,
  ResearchService,
  ReviewerService,
  WebExtractService,
  WriterService,
  type SearchProvider,
  type WebPageExtractor,
} from '@vibe-writer/agent-core'
import type { TextModel, ToolModel } from '@vibe-writer/model-runtime'
import type { WorkflowServices } from '@vibe-writer/workflow-runtime'

export type WorkflowModel = TextModel & ToolModel

export function createWorkflowServices(
  model: WorkflowModel,
  searchProvider?: SearchProvider,
  webPageExtractor?: WebPageExtractor,
): WorkflowServices {
  const planner = new PlannerService(model)
  const coverage = new CoveragePlannerService(model)
  const reviewer = new ReviewerService(model)
  const research = searchProvider ? new ResearchService(searchProvider, model) : null
  const webExtract = webPageExtractor ? new WebExtractService(webPageExtractor) : null

  return {
    plan: (input) => planner.plan(input),
    reviseOutline: (input) => planner.revise(input),
    planCoverage: (input) => coverage.plan(input),
    writeChapter: (input) => {
      let searchIndex = 0
      let extractIndex = 0
      return new WriterService(model, {
        style: input.style,
        ...(research
          ? {
              // Writer 的 search tool 在章节生成过程中才知道真实 query。
              // 在这里投影开始/完成事件，避免用 coverage 的搜索建议冒充真实调用。
              research: async (query, signal, effectScope) => {
                const index = searchIndex + 1
                searchIndex = index
                await input.onResearchProgress?.({ tool: 'search', phase: 'started', query, index })
                const result = await research.research({ query, signal, effectScope })
                const text = result.status === 'ready' ? result.summary : ''
                await input.onResearchProgress?.({
                  tool: 'search',
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
        ...(webExtract
          ? {
              extractWebPage: async (url, signal, effectScope) => {
                const index = extractIndex + 1
                extractIndex = index
                await input.onResearchProgress?.({
                  tool: 'extract_webpage',
                  phase: 'started',
                  url,
                  index,
                })
                const result = await webExtract.extract({ url, signal, effectScope })
                await input.onResearchProgress?.({
                  tool: 'extract_webpage',
                  phase: 'finished',
                  url,
                  index,
                  ...(result.status === 'ready' && result.title
                    ? { sourceTitle: result.title.slice(0, 300) }
                    : {}),
                  chars: result.status === 'ready' ? result.content.length : 0,
                  status: result.status,
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
