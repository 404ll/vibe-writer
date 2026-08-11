import {
  ARTICLE_QUALITY_RUBRIC,
  EvalModelBudget,
  createModelRubricEvaluator,
} from '@vibe-writer/eval-graders'
import {
  fingerprintEvalDataset,
  fingerprintEvalValue,
  runOfflineEval,
  type EvalCase,
  type EvalExecutionSnapshot,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'
import type { TextModel } from '@vibe-writer/model-runtime'
import type { LiveGraderConfig } from './queue-config.ts'
import type { ClaimedEvalContext, EvalQueueExecutor } from './queue-runner.ts'

export const LIVE_ARTICLE_GRADER_TARGET = {
  key: 'live-article-quality',
  version: 'v1',
  graphVersion: 'live-article-quality-eval-v1',
} as const

type LiveArticleInput = {
  schemaVersion: 1
  source: {
    candidateId: string
    articleRevision: number
    contentFingerprint: string
  }
  article: { markdown: string }
}

export function liveArticleGraderExecution(
  config: LiveGraderConfig,
  codeRevision: string,
): EvalExecutionSnapshot {
  return {
    modelProfile: config.profile.modelProfile,
    promptVersion: config.profile.promptVersion,
    graphVersion: LIVE_ARTICLE_GRADER_TARGET.graphVersion,
    toolVersions: {
      rubric: ARTICLE_QUALITY_RUBRIC.version,
      grader: config.profile.version,
      pricing: config.pricing.version,
      budget: `calls:${config.budget.maxCalls}:microusd:${config.budget.maxCostMicrousd}`,
    },
    codeRevision,
  }
}

function liveArticleInput(value: EvalJsonValue): LiveArticleInput {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    typeof value.article !== 'object' || value.article === null || Array.isArray(value.article) ||
    typeof value.article.markdown !== 'string' || !value.article.markdown.trim() ||
    typeof value.source !== 'object' || value.source === null || Array.isArray(value.source) ||
    typeof value.source.candidateId !== 'string' ||
    typeof value.source.articleRevision !== 'number' ||
    typeof value.source.contentFingerprint !== 'string'
  ) {
    throw new Error('Live article Eval case input is invalid')
  }
  return value as LiveArticleInput
}

export class LiveArticleGraderExecutor implements EvalQueueExecutor {
  constructor(
    private readonly model: TextModel,
    private readonly config: LiveGraderConfig,
    private readonly codeRevision: string,
  ) {}

  async execute(context: ClaimedEvalContext, signal: AbortSignal) {
    if (
      !context.suite.workspaceId ||
      context.run.targetKey !== LIVE_ARTICLE_GRADER_TARGET.key ||
      context.run.targetVersion !== LIVE_ARTICLE_GRADER_TARGET.version ||
      fingerprintEvalDataset(context.cases) !== context.run.datasetFingerprint ||
      context.suite.datasetFingerprint !== context.run.datasetFingerprint ||
      fingerprintEvalValue(context.run.executionSnapshot) !== fingerprintEvalValue(
        liveArticleGraderExecution(this.config, this.codeRevision),
      )
    ) {
      throw new Error('Live article grader request identity is unavailable in this worker')
    }
    const cases = context.cases.map<EvalCase<LiveArticleInput, EvalJsonValue>>((evalCase) => ({
      ...evalCase,
      input: liveArticleInput(evalCase.input),
    }))
    const budget = new EvalModelBudget(this.config.budget, this.config.pricing)
    const evaluator = createModelRubricEvaluator<LiveArticleInput, string, EvalJsonValue>({
      model: this.model,
      rubric: ARTICLE_QUALITY_RUBRIC,
      profile: this.config.profile,
      budget,
      renderSubject: ({ output }) => output,
    })
    return runOfflineEval(
      cases,
      {
        key: LIVE_ARTICLE_GRADER_TARGET.key,
        version: LIVE_ARTICLE_GRADER_TARGET.version,
        execute: async (input) => input.article.markdown,
      },
      [evaluator],
      {
        suite: { key: context.suite.suiteKey, version: context.suite.version },
        execution: context.run.executionSnapshot as EvalExecutionSnapshot,
        trialsPerCase: context.run.trialsPerCase,
        captureOutput: false,
        signal,
      },
    )
  }
}
