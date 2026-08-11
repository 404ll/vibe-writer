import { COMPONENT_SUITE } from './component-suite.ts'
import { ComponentEvalQueueExecutor } from './component-queue-executor.ts'
import { LIVE_ARTICLE_GRADER_TARGET } from './live-article-grader-executor.ts'
import { MEMORY_CALIBRATION_TARGET } from './memory-calibration-authorization.ts'
import type { ClaimedEvalContext, EvalQueueExecutor } from './queue-runner.ts'

export class EvalQueueExecutorRegistry implements EvalQueueExecutor {
  constructor(
    private readonly component: ComponentEvalQueueExecutor,
    private readonly liveArticle: EvalQueueExecutor | null,
    private readonly memoryCalibration: EvalQueueExecutor | null = null,
  ) {}

  execute(context: ClaimedEvalContext, signal: AbortSignal) {
    if (
      context.run.targetKey === COMPONENT_SUITE.targetKey &&
      context.run.targetVersion === COMPONENT_SUITE.targetVersion
    ) {
      return this.component.execute(context, signal)
    }
    if (
      context.run.targetKey === MEMORY_CALIBRATION_TARGET.key &&
      context.run.targetVersion === MEMORY_CALIBRATION_TARGET.version
    ) {
      if (!this.memoryCalibration) {
        throw new Error('Memory calibration executor is disabled in this worker')
      }
      return this.memoryCalibration.execute(context, signal)
    }
    if (
      context.run.targetKey === LIVE_ARTICLE_GRADER_TARGET.key &&
      context.run.targetVersion === LIVE_ARTICLE_GRADER_TARGET.version
    ) {
      if (!this.liveArticle) throw new Error('Live article grader is disabled in this worker')
      return this.liveArticle.execute(context, signal)
    }
    throw new Error(
      `Unsupported queued Eval target ${context.run.targetKey}@${context.run.targetVersion}`,
    )
  }
}
