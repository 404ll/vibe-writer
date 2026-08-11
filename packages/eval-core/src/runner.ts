import { createHash } from 'node:crypto'

export type EvalJsonValue =
  | null
  | boolean
  | number
  | string
  | EvalJsonValue[]
  | { [key: string]: EvalJsonValue }

export type EvalExecutionSnapshot = {
  modelProfile: string
  promptVersion: string
  graphVersion: string
  toolVersions: Record<string, string>
  codeRevision: string
}

export type EvalCase<TInput, TExpected = unknown> = {
  key: string
  input: TInput
  expected?: TExpected
  tags?: readonly string[]
}

export type EvalTarget<TInput, TOutput> = {
  key: string
  version: string
  execute(input: TInput, context: { caseKey: string; trialIndex: number; signal?: AbortSignal }): Promise<TOutput>
}

export type EvalScoreResult = {
  value?: number
  passed?: boolean
  metadata?: Record<string, EvalJsonValue>
  modelMetering?: EvalModelMetering
}

export type EvalModelMetering = {
  provider: string
  model: string
  providerRequestId?: string
  providerResponseId?: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  costMicrousd: number
  pricingVersion: string
  costCurrency: 'USD'
}

export type EvalEvaluator<TInput, TOutput, TExpected = unknown> = {
  key: string
  version: string
  metric: string
  evaluate(input: {
    case: EvalCase<TInput, TExpected>
    output: TOutput
    trialIndex: number
    signal?: AbortSignal
  }): Promise<EvalScoreResult> | EvalScoreResult
}

export class EvalEvaluatorFailure extends Error {
  readonly metadata?: Record<string, EvalJsonValue>
  readonly modelMetering?: EvalModelMetering

  constructor(
    message: string,
    metadata?: Record<string, EvalJsonValue>,
    modelMetering?: EvalModelMetering,
  ) {
    super(message)
    this.name = 'EvalEvaluatorFailure'
    this.metadata = metadata
    this.modelMetering = modelMetering
  }
}

export type EvalScoreRecord = {
  evaluatorKey: string
  evaluatorVersion: string
  metric: string
  status: 'succeeded' | 'error'
  value?: number
  passed?: boolean
  metadata?: Record<string, EvalJsonValue>
  modelMetering?: EvalModelMetering
  errorCode?: 'evaluator_error'
  errorMessage?: string
}

export type EvalTrialRecord<TOutput> = {
  caseKey: string
  trialIndex: number
  status: 'succeeded' | 'error'
  outputFingerprint?: string
  output?: TOutput
  scores: EvalScoreRecord[]
  errorCode?: 'target_error'
  errorMessage?: string
  startedAt: string
  finishedAt: string
}

export type EvalRunReport<TOutput> = {
  schemaVersion: 1
  suite: { key: string; version: string; datasetFingerprint: string }
  target: { key: string; version: string; execution: EvalExecutionSnapshot }
  status: 'completed' | 'failed'
  trialsPerCase: number
  trials: EvalTrialRecord<TOutput>[]
  startedAt: string
  finishedAt: string
}

export type RunOfflineEvalOptions = {
  suite: { key: string; version: string }
  execution: EvalExecutionSnapshot
  trialsPerCase?: number
  captureOutput?: boolean
  signal?: AbortSignal
  clock?: () => Date
}

function identifier(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw new Error(`${name} must contain 1-256 non-whitespace characters`)
  }
  return normalized
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Eval values require finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error(`Eval values do not support ${typeof value}`)
  if (ancestors.has(value)) throw new Error('Eval values do not support cycles')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Eval values only support plain JSON objects')
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function fingerprintEvalValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function validateExecution(execution: EvalExecutionSnapshot): EvalExecutionSnapshot {
  const toolVersions = Object.fromEntries(
    Object.entries(execution.toolVersions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [identifier(key, 'tool name'), identifier(value, 'tool version')]),
  )
  if (Object.keys(toolVersions).length === 0) throw new Error('execution.toolVersions cannot be empty')
  return {
    modelProfile: identifier(execution.modelProfile, 'execution.modelProfile'),
    promptVersion: identifier(execution.promptVersion, 'execution.promptVersion'),
    graphVersion: identifier(execution.graphVersion, 'execution.graphVersion'),
    toolVersions,
    codeRevision: identifier(execution.codeRevision, 'execution.codeRevision'),
  }
}

function validateScore(result: EvalScoreResult): EvalScoreResult {
  if (result.value !== undefined && !Number.isFinite(result.value)) {
    throw new Error('Evaluator score must be finite')
  }
  if (result.value === undefined && result.passed === undefined) {
    throw new Error('Evaluator must return a numeric value or pass/fail decision')
  }
  if (result.metadata !== undefined) canonicalJson(result.metadata)
  if (result.modelMetering !== undefined) validateModelMetering(result.modelMetering)
  return result
}

function validateModelMetering(metering: EvalModelMetering): EvalModelMetering {
  identifier(metering.provider, 'modelMetering.provider')
  identifier(metering.model, 'modelMetering.model')
  identifier(metering.pricingVersion, 'modelMetering.pricingVersion')
  if (metering.providerRequestId !== undefined) {
    identifier(metering.providerRequestId, 'modelMetering.providerRequestId')
  }
  if (metering.providerResponseId !== undefined) {
    identifier(metering.providerResponseId, 'modelMetering.providerResponseId')
  }
  for (const [name, value] of Object.entries({
    inputTokens: metering.inputTokens,
    outputTokens: metering.outputTokens,
    cacheReadInputTokens: metering.cacheReadInputTokens,
    cacheWriteInputTokens: metering.cacheWriteInputTokens,
    costMicrousd: metering.costMicrousd,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`modelMetering.${name} must be a non-negative safe integer`)
    }
  }
  if (metering.costCurrency !== 'USD') {
    throw new Error('modelMetering.costCurrency must be USD')
  }
  return metering
}

export function fingerprintEvalDataset<TInput, TExpected>(
  cases: readonly EvalCase<TInput, TExpected>[],
): string {
  const normalized = [...cases]
    .map((item) => ({
      key: identifier(item.key, 'case.key'),
      input: item.input,
      ...(item.expected === undefined ? {} : { expected: item.expected }),
      tags: [...(item.tags ?? [])].map((tag) => identifier(tag, 'case tag')).sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
  if (new Set(normalized.map((item) => item.key)).size !== normalized.length) {
    throw new Error('Eval case keys must be unique')
  }
  return fingerprintEvalValue(normalized)
}

export async function runOfflineEval<TInput, TOutput, TExpected = unknown>(
  cases: readonly EvalCase<TInput, TExpected>[],
  target: EvalTarget<TInput, TOutput>,
  evaluators: readonly EvalEvaluator<TInput, TOutput, TExpected>[],
  options: RunOfflineEvalOptions,
): Promise<EvalRunReport<TOutput>> {
  if (cases.length === 0) throw new Error('Offline eval requires at least one case')
  if (evaluators.length === 0) throw new Error('Offline eval requires at least one evaluator')
  const trialsPerCase = options.trialsPerCase ?? 1
  if (!Number.isInteger(trialsPerCase) || trialsPerCase < 1 || trialsPerCase > 20) {
    throw new Error('trialsPerCase must be an integer between 1 and 20')
  }
  const suite = {
    key: identifier(options.suite.key, 'suite.key'),
    version: identifier(options.suite.version, 'suite.version'),
    datasetFingerprint: fingerprintEvalDataset(cases),
  }
  const targetIdentity = {
    key: identifier(target.key, 'target.key'),
    version: identifier(target.version, 'target.version'),
    execution: validateExecution(options.execution),
  }
  const evaluatorKeys = evaluators.map((evaluator) =>
    `${identifier(evaluator.key, 'evaluator.key')}@${identifier(evaluator.version, 'evaluator.version')}:${identifier(evaluator.metric, 'evaluator.metric')}`,
  )
  if (new Set(evaluatorKeys).size !== evaluatorKeys.length) {
    throw new Error('Evaluator key/version/metric identities must be unique')
  }

  const clock = options.clock ?? (() => new Date())
  const startedAt = clock().toISOString()
  const trials: EvalTrialRecord<TOutput>[] = []

  for (const evalCase of cases) {
    const caseKey = identifier(evalCase.key, 'case.key')
    for (let trialIndex = 0; trialIndex < trialsPerCase; trialIndex += 1) {
      if (options.signal?.aborted) throw new DOMException('Evaluation aborted.', 'AbortError')
      const trialStartedAt = clock().toISOString()
      let output: TOutput
      try {
        output = await target.execute(evalCase.input, {
          caseKey,
          trialIndex,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      } catch {
        trials.push({
          caseKey,
          trialIndex,
          status: 'error',
          scores: [],
          errorCode: 'target_error',
          errorMessage: 'Eval target execution failed.',
          startedAt: trialStartedAt,
          finishedAt: clock().toISOString(),
        })
        continue
      }

      const outputFingerprint = fingerprintEvalValue(output)
      const scores: EvalScoreRecord[] = []
      for (const evaluator of evaluators) {
        const base = {
          evaluatorKey: identifier(evaluator.key, 'evaluator.key'),
          evaluatorVersion: identifier(evaluator.version, 'evaluator.version'),
          metric: identifier(evaluator.metric, 'evaluator.metric'),
        }
        try {
          const result = validateScore(await evaluator.evaluate({
            case: evalCase,
            output,
            trialIndex,
            ...(options.signal ? { signal: options.signal } : {}),
          }))
          scores.push({ ...base, status: 'succeeded', ...result })
        } catch (error) {
          scores.push({
            ...base,
            status: 'error',
            errorCode: 'evaluator_error',
            errorMessage: 'Eval evaluator failed.',
            ...(error instanceof EvalEvaluatorFailure && error.metadata
              ? { metadata: error.metadata }
              : {}),
            ...(error instanceof EvalEvaluatorFailure && error.modelMetering
              ? { modelMetering: validateModelMetering(error.modelMetering) }
              : {}),
          })
        }
      }
      trials.push({
        caseKey,
        trialIndex,
        status: 'succeeded',
        outputFingerprint,
        ...(options.captureOutput ? { output } : {}),
        scores,
        startedAt: trialStartedAt,
        finishedAt: clock().toISOString(),
      })
    }
  }

  return {
    schemaVersion: 1,
    suite,
    target: targetIdentity,
    status: trials.some(
      (trial) =>
        trial.status === 'error' || trial.scores.some((score) => score.status === 'error'),
    ) ? 'failed' : 'completed',
    trialsPerCase,
    trials,
    startedAt,
    finishedAt: clock().toISOString(),
  }
}
