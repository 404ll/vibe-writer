import type {
  ApproveMemoryCalibrationAuthorizationInput,
  AuthorizedWorkspaceScope,
  EnqueueMemoryCalibrationAuthorizationInput,
  EvalRunRow,
  MemoryCalibrationAuthorizationRow,
  RegisterMemoryCalibrationAuthorizationInput,
} from '@vibe-writer/db'
import type { EvalExecutionSnapshot } from '@vibe-writer/eval-core'
import { MEMORY_EXTRACTION_DATASET_VERSION } from './memory-extraction-dataset.ts'
import { memoryExtractionEvalCases } from './memory-extraction-suite.ts'
import {
  memoryCalibrationBindingSnapshot,
  preflightMemoryCalibrationExecution,
  type MemoryCalibrationExecutionManifest,
} from './memory-calibration-execution.ts'

export const MEMORY_CALIBRATION_TARGET = {
  key: 'memory-extraction-live-calibration',
  version: 'v1',
  graphVersion: 'memory-extraction-live-calibration-v1',
} as const

export type MemoryCalibrationAuthorizationStore = {
  register(
    scope: AuthorizedWorkspaceScope,
    input: RegisterMemoryCalibrationAuthorizationInput,
  ): Promise<{ authorization: MemoryCalibrationAuthorizationRow; created: boolean }>
  approve(
    scope: AuthorizedWorkspaceScope,
    input: ApproveMemoryCalibrationAuthorizationInput,
  ): Promise<{ authorization: MemoryCalibrationAuthorizationRow; approved: boolean }>
  enqueue(
    scope: AuthorizedWorkspaceScope,
    input: EnqueueMemoryCalibrationAuthorizationInput,
  ): Promise<{
    authorization: MemoryCalibrationAuthorizationRow
    run: EvalRunRow
    enqueued: boolean
  }>
}

export function memoryCalibrationBaseExecution(
  execution: MemoryCalibrationExecutionManifest,
  bindingFingerprint: string,
): EvalExecutionSnapshot {
  return {
    modelProfile: execution.target.modelProfile,
    promptVersion: execution.target.promptVersion,
    graphVersion: MEMORY_CALIBRATION_TARGET.graphVersion,
    toolVersions: {
      extractor: execution.target.extractorVersion,
      memoryExtractionContract: 'v1',
      sourceContract: 'trusted-segments-v1',
      pricing: execution.pricing.version,
      budget: `calls:${execution.budget.maxCalls}:microusd:${execution.budget.maxCostMicrousd}`,
      binding: bindingFingerprint,
    },
    codeRevision: execution.target.codeRevision,
  }
}

export class MemoryCalibrationAuthorizationService {
  constructor(private readonly store: MemoryCalibrationAuthorizationStore) {}

  register(scope: AuthorizedWorkspaceScope, input: {
    idempotencyKey: string
    execution: unknown
  }) {
    const preflight = preflightMemoryCalibrationExecution(input.execution)
    if (preflight.execution.authorization.status !== 'not_authorized') {
      throw new Error('Memory calibration registration requires an unapproved manifest')
    }
    return this.store.register(scope, {
      idempotencyKey: input.idempotencyKey,
      suiteKey: MEMORY_CALIBRATION_TARGET.key,
      suiteVersion: MEMORY_EXTRACTION_DATASET_VERSION,
      name: 'Memory extraction live calibration',
      description: 'Tracked synthetic Memory extraction calibration dataset.',
      cases: memoryExtractionEvalCases(),
      binding: memoryCalibrationBindingSnapshot(preflight.execution),
      baseExecution: memoryCalibrationBaseExecution(
        preflight.execution,
        preflight.bindingFingerprint,
      ),
      targetKey: MEMORY_CALIBRATION_TARGET.key,
      targetVersion: MEMORY_CALIBRATION_TARGET.version,
      trialsPerCase: preflight.callCount / memoryExtractionEvalCases().length,
    })
  }

  approve(scope: AuthorizedWorkspaceScope, input: ApproveMemoryCalibrationAuthorizationInput) {
    return this.store.approve(scope, input)
  }

  enqueue(scope: AuthorizedWorkspaceScope, input: EnqueueMemoryCalibrationAuthorizationInput) {
    return this.store.enqueue(scope, input)
  }
}
