import {
  EvalEvaluatorFailure,
  fingerprintEvalDataset,
  fingerprintEvalModelExecutionBinding,
  parseEvalModelExecutionBinding,
  parseEvalModelPricingSnapshot,
  runOfflineEval,
  type EvalEvaluator,
  type EvalJsonValue,
  type EvalModelExecutionBinding,
  type EvalModelMetering,
  type EvalModelPricingSnapshot,
  type EvalRunReport,
} from '@vibe-writer/eval-core'
import {
  EvalModelBudget,
  maximumModelCallCostMicrousd,
} from '@vibe-writer/eval-graders'
import {
  MEMORY_EXTRACTOR_PROMPT,
  buildMemoryExtractorPrompt,
  parseMemoryExtractorResponse,
  scoreMemoryExtractionQuality,
  type MemoryExtractionOutput,
  type MemoryExtractionQualityCase,
  type MemoryExtractionQualityMetrics,
} from '@vibe-writer/memory-core'
import type { TextModel } from '@vibe-writer/model-runtime'
import { memoryExtractionQualityCases } from './memory-extraction-dataset.ts'
import { memoryExtractionEvalCases } from './memory-extraction-suite.ts'
import { readTrackedMemoryCalibrationReadiness } from './memory-calibration-readiness.ts'

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/

type JsonRecord = Record<string, unknown>

export type MemoryCalibrationExecutionAuthorization =
  | {
      status: 'not_authorized'
      approvalId: null
      approvedBy: null
      approvedAt: null
      bindingFingerprint: null
    }
  | {
      status: 'approved'
      approvalId: string
      approvedBy: string
      approvedAt: string
      bindingFingerprint: string
    }

export type MemoryCalibrationExecutionManifest = EvalModelExecutionBinding & {
  authorization: MemoryCalibrationExecutionAuthorization
}

type CalibrationTargetOutput = {
  schemaVersion: 1
  responseStatus: 'valid' | 'quality_invalid' | 'contract_error'
  failureReason: string | null
  parsed: MemoryExtractionOutput | null
  metering: EvalModelMetering
}

export type MemoryCalibrationPreflight = {
  status: 'ready_for_authorization' | 'authorized'
  executable: boolean
  productionEligible: false
  automaticUncertainResolutionEligible: false
  bindingFingerprint: string
  datasetFingerprint: string
  callCount: number
  maximumCostMicrousd: number
  pricingVersion: string
  currency: 'USD'
  remainingProductionBlockers: string[]
  execution: MemoryCalibrationExecutionManifest
}

function record(value: unknown, name: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as JsonRecord
}

function exactKeys(value: JsonRecord, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has an invalid field inventory`)
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error(`${name} must be a bounded non-empty string`)
  }
  return value
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonnegativeInteger(value, name)
  if (parsed < 1) throw new Error(`${name} must be positive`)
  return parsed
}

function parseAuthorization(value: unknown): MemoryCalibrationExecutionAuthorization {
  const authorization = record(value, 'authorization')
  exactKeys(authorization, [
    'status', 'approvalId', 'approvedBy', 'approvedAt', 'bindingFingerprint',
  ], 'authorization')
  if (authorization.status === 'not_authorized') {
    if (
      authorization.approvalId !== null || authorization.approvedBy !== null ||
      authorization.approvedAt !== null || authorization.bindingFingerprint !== null
    ) {
      throw new Error('Unapproved calibration execution cannot carry approval evidence')
    }
    return {
      status: 'not_authorized',
      approvalId: null,
      approvedBy: null,
      approvedAt: null,
      bindingFingerprint: null,
    }
  }
  if (authorization.status !== 'approved') {
    throw new Error('Calibration execution authorization status is unsupported')
  }
  const approvedAt = identifier(authorization.approvedAt, 'authorization.approvedAt')
  if (!ISO_INSTANT.test(approvedAt) || Number.isNaN(Date.parse(approvedAt))) {
    throw new Error('authorization.approvedAt must be an ISO UTC instant')
  }
  const bindingFingerprint = identifier(
    authorization.bindingFingerprint,
    'authorization.bindingFingerprint',
  )
  if (!FINGERPRINT.test(bindingFingerprint)) {
    throw new Error('authorization.bindingFingerprint is invalid')
  }
  return {
    status: 'approved',
    approvalId: identifier(authorization.approvalId, 'authorization.approvalId'),
    approvedBy: identifier(authorization.approvedBy, 'authorization.approvedBy'),
    approvedAt,
    bindingFingerprint,
  }
}

export function parseMemoryCalibrationExecutionManifest(
  value: unknown,
): MemoryCalibrationExecutionManifest {
  const root = record(value, 'Memory calibration execution manifest')
  exactKeys(root, [
    'schemaVersion', 'planKey', 'datasetFingerprint', 'target', 'generation',
    'pricing', 'budget', 'authorization',
  ], 'Memory calibration execution manifest')
  const binding = parseEvalModelExecutionBinding({
    schemaVersion: root.schemaVersion,
    planKey: root.planKey,
    datasetFingerprint: root.datasetFingerprint,
    target: root.target,
    generation: root.generation,
    pricing: root.pricing,
    budget: root.budget,
  })
  return {
    ...binding,
    authorization: parseAuthorization(root.authorization),
  }
}

export function memoryCalibrationBindingSnapshot(
  execution: MemoryCalibrationExecutionManifest,
): EvalModelExecutionBinding {
  return parseEvalModelExecutionBinding({
    schemaVersion: execution.schemaVersion,
    planKey: execution.planKey,
    datasetFingerprint: execution.datasetFingerprint,
    target: execution.target,
    generation: execution.generation,
    pricing: execution.pricing,
    budget: execution.budget,
  })
}

export function fingerprintMemoryCalibrationBinding(
  execution: MemoryCalibrationExecutionManifest,
): string {
  return fingerprintEvalModelExecutionBinding(memoryCalibrationBindingSnapshot(execution))
}

function maximumExecutionCostMicrousd(input: {
  cases: readonly MemoryExtractionQualityCase[]
  trialsPerCase: number
  maxOutputTokens: number
  pricing: EvalModelPricingSnapshot
}): number {
  let maximumCostMicrousd = 0
  for (const qualityCase of input.cases) {
    const prompt = buildMemoryExtractorPrompt(qualityCase.input)
    const inputUtf8Bytes = Buffer.byteLength(prompt.system, 'utf8') +
      Buffer.byteLength(prompt.user, 'utf8')
    const callMaximum = maximumModelCallCostMicrousd({
      inputUtf8Bytes,
      maxOutputTokens: input.maxOutputTokens,
      pricing: input.pricing,
    })
    maximumCostMicrousd += callMaximum * input.trialsPerCase
    if (!Number.isSafeInteger(maximumCostMicrousd)) {
      throw new Error('Calibration maximum cost exceeds the safe integer range')
    }
  }
  return maximumCostMicrousd
}

export function quoteTrackedMemoryCalibrationCost(input: {
  maxOutputTokens: number
  pricing: unknown
}) {
  const readiness = readTrackedMemoryCalibrationReadiness()
  const maxOutputTokens = positiveInteger(input.maxOutputTokens, 'maxOutputTokens')
  const pricing = parseEvalModelPricingSnapshot(input.pricing)
  return {
    planKey: 'memory-extraction-live-calibration' as const,
    datasetFingerprint: readiness.dataset.fingerprint,
    callCount: readiness.runPolicy.maxCalls,
    trialsPerCase: readiness.runPolicy.trialsPerCase,
    maxOutputTokens,
    maximumCostMicrousd: maximumExecutionCostMicrousd({
      cases: memoryExtractionQualityCases(),
      trialsPerCase: readiness.runPolicy.trialsPerCase,
      maxOutputTokens,
      pricing,
    }),
    pricing,
    currency: 'USD' as const,
  }
}

export function preflightMemoryCalibrationExecution(
  value: unknown,
): MemoryCalibrationPreflight {
  const execution = parseMemoryCalibrationExecutionManifest(value)
  const readiness = readTrackedMemoryCalibrationReadiness()
  const evalCases = memoryExtractionEvalCases()
  const datasetFingerprint = fingerprintEvalDataset(evalCases)
  if (execution.planKey !== 'memory-extraction-live-calibration') {
    throw new Error('Calibration execution plan identity is unsupported')
  }
  if (
    execution.datasetFingerprint !== readiness.dataset.fingerprint ||
    execution.datasetFingerprint !== datasetFingerprint
  ) {
    throw new Error('Calibration execution dataset does not match the tracked plan')
  }
  if (
    execution.target.provider !== readiness.target.provider ||
    execution.target.promptVersion !== readiness.target.promptVersion ||
    execution.target.promptVersion !== MEMORY_EXTRACTOR_PROMPT.version ||
    execution.target.extractorVersion !== readiness.target.extractorVersion
  ) {
    throw new Error('Calibration execution target drifted from the tracked plan')
  }
  if (execution.budget.maxCalls !== readiness.runPolicy.maxCalls) {
    throw new Error('Calibration execution call budget must match the tracked trial inventory')
  }
  const quote = quoteTrackedMemoryCalibrationCost({
    maxOutputTokens: execution.generation.maxOutputTokens,
    pricing: execution.pricing,
  })
  const maximumCostMicrousd = quote.maximumCostMicrousd
  if (execution.budget.maxCostMicrousd !== maximumCostMicrousd) {
    throw new Error('Calibration execution cost cap must equal the conservative preflight maximum')
  }
  const bindingFingerprint = fingerprintMemoryCalibrationBinding(execution)
  if (
    execution.authorization.status === 'approved' &&
    execution.authorization.bindingFingerprint !== bindingFingerprint
  ) {
    throw new Error('Calibration execution approval does not match the immutable binding')
  }
  return {
    status: execution.authorization.status === 'approved' ? 'authorized' : 'ready_for_authorization',
    executable: execution.authorization.status === 'approved',
    productionEligible: false,
    automaticUncertainResolutionEligible: false,
    bindingFingerprint,
    datasetFingerprint,
    callCount: readiness.runPolicy.maxCalls,
    maximumCostMicrousd,
    pricingVersion: execution.pricing.version,
    currency: 'USD',
    remainingProductionBlockers: [
      'live_trials_missing',
      'request_level_terminal_lookup_unavailable',
    ],
    execution,
  }
}

function metering(input: {
  provider: string
  model: string
  requestId?: string
  responseId?: string
  usage: NonNullable<Awaited<ReturnType<TextModel['generate']>>['usage']>
  costMicrousd: number
  pricingVersion: string
}): EvalModelMetering {
  return {
    provider: input.provider,
    model: input.model,
    ...(input.requestId ? { providerRequestId: input.requestId } : {}),
    ...(input.responseId ? { providerResponseId: input.responseId } : {}),
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadInputTokens: input.usage.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: input.usage.cacheWriteInputTokens ?? 0,
    costMicrousd: input.costMicrousd,
    pricingVersion: input.pricingVersion,
    costCurrency: 'USD',
  }
}

function caseMetrics(
  qualityCase: MemoryExtractionQualityCase,
  output: MemoryExtractionOutput | null,
): MemoryExtractionQualityMetrics {
  return scoreMemoryExtractionQuality({
    cases: [qualityCase],
    outputs: { [qualityCase.key]: output },
  })
}

function metricMetadata(input: {
  category: MemoryExtractionQualityCase['category']
  failureReason: string | null
  quality: MemoryExtractionQualityMetrics
}): Record<string, EvalJsonValue> {
  return {
    category: input.category,
    failureReason: input.failureReason,
    validOutputCount: input.quality.validOutputCount,
    invalidOutputCount: input.quality.invalidOutputCount,
    truePositiveCount: input.quality.truePositiveCount,
    falsePositiveCount: input.quality.falsePositiveCount,
    falseNegativeCount: input.quality.falseNegativeCount,
    trueNegativeCount: input.quality.trueNegativeCount,
    slotExactCount: input.quality.slotExactCount,
    positiveCaseCount: input.quality.positiveCaseCount,
    candidateExactCount: input.quality.candidateExactCount,
    taskLeakCount: input.quality.taskLeakCount,
    assistantLeakCount: input.quality.assistantLeakCount,
    sensitiveLeakCount: input.quality.sensitiveLeakCount,
  }
}

function calibrationEvaluator(
  byKey: ReadonlyMap<string, MemoryExtractionQualityCase>,
): EvalEvaluator<MemoryExtractionQualityCase['input'], CalibrationTargetOutput, MemoryExtractionQualityCase['expected']> {
  return {
    key: 'memory-extraction-live-quality',
    version: 'v1',
    metric: 'memory_extraction_live_quality',
    evaluate({ case: evalCase, output }) {
      const qualityCase = byKey.get(evalCase.key)
      if (!qualityCase) throw new Error('Calibration evaluator case identity is unavailable')
      const quality = caseMetrics(qualityCase, output.parsed)
      const metadata = metricMetadata({
        category: qualityCase.category,
        failureReason: output.failureReason,
        quality,
      })
      if (output.responseStatus === 'contract_error') {
        throw new EvalEvaluatorFailure(
          'Memory calibration provider contract evidence is incomplete',
          metadata,
          output.metering,
        )
      }
      const passed = output.responseStatus === 'valid' &&
        quality.invalidOutputCount === 0 &&
        quality.falsePositiveCount === 0 &&
        quality.falseNegativeCount === 0 &&
        quality.slotExactRate === 1
      return {
        value: passed ? 1 : 0,
        passed,
        metadata,
        modelMetering: output.metering,
      }
    },
  }
}

function numberMetadata(value: EvalJsonValue | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Calibration score metadata is missing ${name}`)
  }
  return value as number
}

function ratio(numerator: number, denominator: number, emptyValue: number): number {
  return denominator === 0 ? emptyValue : numerator / denominator
}

function aggregateQuality(
  report: EvalRunReport<CalibrationTargetOutput>,
): MemoryExtractionQualityMetrics | null {
  const scores = report.trials.flatMap((trial) => trial.scores)
  if (
    report.status !== 'completed' ||
    scores.length !== report.trials.length ||
    scores.some((score) => score.status !== 'succeeded' || !score.metadata)
  ) {
    return null
  }
  const totals = {
    validOutputCount: 0,
    invalidOutputCount: 0,
    truePositiveCount: 0,
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    trueNegativeCount: 0,
    slotExactCount: 0,
    positiveCaseCount: 0,
    candidateExactCount: 0,
    taskLeakCount: 0,
    assistantLeakCount: 0,
    sensitiveLeakCount: 0,
  }
  for (const score of scores) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += numberMetadata(score.metadata?.[key], key)
    }
  }
  const caseCount = report.trials.length
  return {
    caseCount,
    ...totals,
    shouldWritePrecision: ratio(
      totals.truePositiveCount,
      totals.truePositiveCount + totals.falsePositiveCount,
      1,
    ),
    shouldWriteRecall: ratio(
      totals.truePositiveCount,
      totals.truePositiveCount + totals.falseNegativeCount,
      1,
    ),
    shouldWriteAccuracy: ratio(
      totals.truePositiveCount + totals.trueNegativeCount,
      caseCount,
      0,
    ),
    slotExactRate: ratio(totals.slotExactCount, totals.positiveCaseCount, 1),
    candidateExactRate: ratio(totals.candidateExactCount, totals.positiveCaseCount, 1),
  }
}

function qualityGateFailures(quality: MemoryExtractionQualityMetrics | null): string[] {
  if (!quality) return ['calibration_report_incomplete']
  const gates = readTrackedMemoryCalibrationReadiness().qualityGates
  const failures: string[] = []
  if (quality.shouldWritePrecision < gates.minimumShouldWritePrecision) failures.push('precision_below_gate')
  if (quality.shouldWriteRecall < gates.minimumShouldWriteRecall) failures.push('recall_below_gate')
  if (quality.shouldWriteAccuracy < gates.minimumShouldWriteAccuracy) failures.push('accuracy_below_gate')
  if (quality.slotExactRate < gates.minimumSlotExactRate) failures.push('slot_exact_below_gate')
  if (quality.invalidOutputCount > gates.maximumInvalidOutputCount) failures.push('invalid_output_above_gate')
  if (quality.taskLeakCount > gates.maximumTaskLeakCount) failures.push('task_leak_above_gate')
  if (quality.assistantLeakCount > gates.maximumAssistantLeakCount) failures.push('assistant_leak_above_gate')
  if (quality.sensitiveLeakCount > gates.maximumSensitiveLeakCount) failures.push('sensitive_leak_above_gate')
  return failures
}

export async function runMemoryCalibrationExecution(input: {
  execution: unknown
  model: TextModel
  signal?: AbortSignal
  clock?: () => Date
}) {
  const preflight = preflightMemoryCalibrationExecution(input.execution)
  if (!preflight.executable) {
    throw new Error('Memory calibration execution requires explicit bound approval')
  }
  const execution = preflight.execution
  if (execution.authorization.status !== 'approved') {
    throw new Error('Memory calibration execution approval is unavailable')
  }
  const qualityCases = memoryExtractionQualityCases()
  const byKey = new Map(qualityCases.map((qualityCase) => [qualityCase.key, qualityCase]))
  const cases = memoryExtractionEvalCases()
  const budget = new EvalModelBudget(execution.budget, execution.pricing)
  let haltReason: string | null = null
  const target = {
    key: 'memory-extraction-live-calibration',
    version: 'v1',
    async execute(caseInput: MemoryExtractionQualityCase['input'], context: { signal?: AbortSignal }) {
      if (haltReason) throw new Error(`Calibration execution halted: ${haltReason}`)
      const prompt = buildMemoryExtractorPrompt(caseInput)
      const inputUtf8Bytes = Buffer.byteLength(prompt.system, 'utf8') +
        Buffer.byteLength(prompt.user, 'utf8')
      const reservation = budget.reserve(inputUtf8Bytes, execution.generation.maxOutputTokens)
      let response
      try {
        response = await input.model.generate({
          operation: 'eval.memory.calibration',
          promptVersion: execution.target.promptVersion,
          system: prompt.system,
          user: prompt.user,
          maxTokens: execution.generation.maxOutputTokens,
          ...(context.signal ? { signal: context.signal } : {}),
          metadata: {
            modelProfile: execution.target.modelProfile,
            extractorVersion: execution.target.extractorVersion,
            calibrationBinding: preflight.bindingFingerprint,
          },
        })
      } catch {
        budget.markUnmetered(reservation)
        haltReason = 'provider_call_failed_unmetered'
        throw new Error(haltReason)
      }
      if (!response.usage) {
        budget.markUnmetered(reservation)
        haltReason = 'provider_usage_missing'
        throw new Error(haltReason)
      }
      let costMicrousd: number
      try {
        costMicrousd = budget.settle(reservation, response.usage)
      } catch {
        haltReason = 'provider_usage_exceeded_reservation'
        throw new Error(haltReason)
      }
      const modelMetering = metering({
        provider: response.provider,
        model: response.model,
        ...(response.requestId ? { requestId: response.requestId } : {}),
        ...(response.responseId ? { responseId: response.responseId } : {}),
        usage: response.usage,
        costMicrousd,
        pricingVersion: execution.pricing.version,
      })
      if (
        response.provider !== execution.target.provider ||
        response.model !== execution.target.model
      ) {
        haltReason = 'provider_identity_mismatch'
        return {
          schemaVersion: 1 as const,
          responseStatus: 'contract_error' as const,
          failureReason: haltReason,
          parsed: null,
          metering: modelMetering,
        }
      }
      if (!response.requestId || !response.responseId) {
        haltReason = 'provider_identity_incomplete'
        return {
          schemaVersion: 1 as const,
          responseStatus: 'contract_error' as const,
          failureReason: haltReason,
          parsed: null,
          metering: modelMetering,
        }
      }
      if (response.finishReason !== 'stop') {
        return {
          schemaVersion: 1 as const,
          responseStatus: 'quality_invalid' as const,
          failureReason: 'finish_reason_invalid',
          parsed: null,
          metering: modelMetering,
        }
      }
      try {
        return {
          schemaVersion: 1 as const,
          responseStatus: 'valid' as const,
          failureReason: null,
          parsed: parseMemoryExtractorResponse(response.text),
          metering: modelMetering,
        }
      } catch {
        return {
          schemaVersion: 1 as const,
          responseStatus: 'quality_invalid' as const,
          failureReason: 'response_invalid',
          parsed: null,
          metering: modelMetering,
        }
      }
    },
  }
  const report = await runOfflineEval(
    cases,
    target,
    [calibrationEvaluator(byKey)],
    {
      suite: {
        key: 'memory-extraction-live-calibration',
        version: '2026-08-07-v1',
      },
      execution: {
        modelProfile: execution.target.modelProfile,
        promptVersion: execution.target.promptVersion,
        graphVersion: 'memory-extraction-live-calibration-v1',
        toolVersions: {
          extractor: execution.target.extractorVersion,
          memoryExtractionContract: 'v1',
          sourceContract: 'trusted-segments-v1',
          pricing: execution.pricing.version,
          budget: `calls:${execution.budget.maxCalls}:microusd:${execution.budget.maxCostMicrousd}`,
          approval: execution.authorization.approvalId,
          binding: preflight.bindingFingerprint,
        },
        codeRevision: execution.target.codeRevision,
      },
      trialsPerCase: readTrackedMemoryCalibrationReadiness().runPolicy.trialsPerCase,
      captureOutput: false,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.clock ? { clock: input.clock } : {}),
    },
  )
  const quality = aggregateQuality(report)
  const gateFailures = qualityGateFailures(quality)
  return {
    preflight,
    report,
    quality,
    gate: { passed: gateFailures.length === 0, failures: gateFailures },
    budget: budget.snapshot(),
    decision: {
      calibrationStatus: gateFailures.length === 0 ? 'quality_gate_passed' as const : 'no_go' as const,
      productionEligible: false as const,
      automaticUncertainResolutionEligible: false as const,
      remainingProductionBlockers: preflight.remainingProductionBlockers,
    },
  }
}
