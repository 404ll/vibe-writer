import type {
  MemoryCalibrationAuthorizationRow,
} from '@vibe-writer/db'
import {
  fingerprintEvalDataset,
  fingerprintEvalModelExecutionBinding,
  fingerprintEvalValue,
} from '@vibe-writer/eval-core'
import type { TextModel } from '@vibe-writer/model-runtime'
import {
  MEMORY_CALIBRATION_TARGET,
  memoryCalibrationBaseExecution,
} from './memory-calibration-authorization.ts'
import {
  preflightMemoryCalibrationExecution,
  runMemoryCalibrationExecution,
  type MemoryCalibrationExecutionManifest,
} from './memory-calibration-execution.ts'
import type { ClaimedEvalContext, EvalQueueExecutor } from './queue-runner.ts'

export type MemoryCalibrationAuthorizationLookup = {
  getEnqueuedByRunId(evalRunId: string): Promise<MemoryCalibrationAuthorizationRow | null>
}

export class MemoryCalibrationQueueExecutor implements EvalQueueExecutor {
  constructor(
    private readonly authorizations: MemoryCalibrationAuthorizationLookup,
    private readonly model: TextModel,
  ) {}

  async execute(context: ClaimedEvalContext, signal: AbortSignal) {
    const authorization = await this.authorizations.getEnqueuedByRunId(context.run.id)
    if (
      !authorization ||
      !authorization.approvalId ||
      !authorization.approvedByPrincipalId ||
      !authorization.approvedAt ||
      authorization.workspaceId !== context.suite.workspaceId ||
      authorization.suiteId !== context.suite.id ||
      authorization.evalRunId !== context.run.id ||
      context.run.targetKey !== MEMORY_CALIBRATION_TARGET.key ||
      context.run.targetVersion !== MEMORY_CALIBRATION_TARGET.version
    ) {
      throw new Error('Memory calibration authorization identity is unavailable in this worker')
    }
    const bindingFingerprint = fingerprintEvalModelExecutionBinding(
      authorization.bindingSnapshot,
    )
    const manifest: MemoryCalibrationExecutionManifest = {
      ...authorization.bindingSnapshot,
      authorization: {
        status: 'approved',
        approvalId: authorization.approvalId,
        approvedBy: authorization.approvedByPrincipalId,
        approvedAt: authorization.approvedAt.toISOString(),
        bindingFingerprint,
      },
    }
    const preflight = preflightMemoryCalibrationExecution(manifest)
    const expectedExecution = {
      ...memoryCalibrationBaseExecution(preflight.execution, preflight.bindingFingerprint),
      toolVersions: {
        ...memoryCalibrationBaseExecution(
          preflight.execution,
          preflight.bindingFingerprint,
        ).toolVersions,
        approval: authorization.approvalId,
      },
    }
    if (
      authorization.bindingFingerprint !== bindingFingerprint ||
      context.run.datasetFingerprint !== authorization.bindingSnapshot.datasetFingerprint ||
      context.suite.datasetFingerprint !== authorization.bindingSnapshot.datasetFingerprint ||
      fingerprintEvalDataset(context.cases) !== authorization.bindingSnapshot.datasetFingerprint ||
      fingerprintEvalValue(context.run.executionSnapshot) !== fingerprintEvalValue(expectedExecution)
    ) {
      throw new Error('Memory calibration queued execution drifted from its approval')
    }
    const result = await runMemoryCalibrationExecution({
      execution: manifest,
      model: this.model,
      signal,
    })
    if (
      result.report.suite.key !== context.suite.suiteKey ||
      result.report.suite.version !== context.suite.version ||
      result.report.suite.datasetFingerprint !== context.run.datasetFingerprint ||
      fingerprintEvalValue(result.report.target.execution) !==
        fingerprintEvalValue(context.run.executionSnapshot)
    ) {
      throw new Error('Memory calibration report identity does not match the claimed run')
    }
    return result.report
  }
}
