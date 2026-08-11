import {
  fingerprintEvalDataset,
  fingerprintEvalValue,
  runOfflineEval,
  type EvalCase,
  type EvalExecutionSnapshot,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'
import {
  COMPONENT_SUITE,
  componentEvalDefinition,
  type ComponentInput,
} from './component-suite.ts'
import type { ClaimedEvalContext, EvalQueueExecutor } from './queue-runner.ts'

function assertComponentIdentity(context: ClaimedEvalContext) {
  const definition = componentEvalDefinition()
  if (
    context.suite.suiteKey !== COMPONENT_SUITE.key ||
    context.suite.version !== COMPONENT_SUITE.version ||
    context.run.targetKey !== COMPONENT_SUITE.targetKey ||
    context.run.targetVersion !== COMPONENT_SUITE.targetVersion
  ) {
    throw new Error(
      `Unsupported queued Eval target ${context.suite.suiteKey}@${context.suite.version}/` +
      `${context.run.targetKey}@${context.run.targetVersion}`,
    )
  }
  if (
    fingerprintEvalDataset(context.cases) !== context.run.datasetFingerprint ||
    context.suite.datasetFingerprint !== context.run.datasetFingerprint
  ) {
    throw new Error('Queued component Eval dataset does not match its immutable request')
  }
  if (
    fingerprintEvalValue(context.run.executionSnapshot) !==
    fingerprintEvalValue(definition.options.execution)
  ) {
    throw new Error('Queued component Eval execution snapshot is not available in this worker')
  }
  return definition
}

export class ComponentEvalQueueExecutor implements EvalQueueExecutor {
  async execute(context: ClaimedEvalContext, signal: AbortSignal) {
    const definition = assertComponentIdentity(context)
    return runOfflineEval(
      context.cases as Array<EvalCase<ComponentInput, EvalJsonValue>>,
      definition.target,
      definition.evaluators,
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
