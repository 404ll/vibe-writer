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
    writeChapter: (input) => new WriterService(model, {
      style: input.style,
      ...(research
        ? {
            research: (query, signal, effectScope) =>
              research.research({ query, signal, effectScope }),
          }
        : {}),
    }).write(input),
    reviewChapter: (input) => reviewer.reviewChapter(input),
    reviewFull: (input) => reviewer.reviewFull(input),
  }
}
