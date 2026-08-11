import type { EvalRunReport } from './runner'

export type EvalMetricSummary = {
  scoreCount: number
  errorCount: number
  passedCount: number
  failedCount: number
  passRate: number | null
  numericCount: number
  numericMean: number | null
}

export type EvalReportSummary = {
  status: 'completed' | 'failed'
  caseKeys: string[]
  trialCount: number
  targetErrorCount: number
  evaluatorErrorCount: number
  metrics: Record<string, EvalMetricSummary>
}

export type EvalMetricGate = {
  scoreCount: number
  maximumErrorCount: number
  minimumPassRate?: number
  minimumNumericMean?: number
}

export type EvalBaseline = {
  schemaVersion: 1
  suite: {
    key: string
    version: string
    datasetFingerprint: string
  }
  target: { key: string; version: string }
  trialsPerCase: number
  expectedCaseKeys: string[]
  maximumTargetErrors: number
  maximumEvaluatorErrors: number
  metrics: Record<string, EvalMetricGate>
}

export type EvalBaselineComparison = {
  passed: boolean
  failures: string[]
  summary: EvalReportSummary
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function parseEvalBaseline(value: unknown): EvalBaseline {
  const root = record(value)
  const suite = record(root?.suite)
  const target = record(root?.target)
  const metrics = record(root?.metrics)
  if (
    root?.schemaVersion !== 1 ||
    !nonempty(suite?.key) ||
    !nonempty(suite?.version) ||
    typeof suite?.datasetFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(suite.datasetFingerprint) ||
    !nonempty(target?.key) ||
    !nonempty(target?.version) ||
    !nonnegativeInteger(root.trialsPerCase) ||
    root.trialsPerCase < 1 ||
    root.trialsPerCase > 20 ||
    !Array.isArray(root.expectedCaseKeys) ||
    root.expectedCaseKeys.length === 0 ||
    !root.expectedCaseKeys.every(nonempty) ||
    new Set(root.expectedCaseKeys).size !== root.expectedCaseKeys.length ||
    !nonnegativeInteger(root.maximumTargetErrors) ||
    !nonnegativeInteger(root.maximumEvaluatorErrors) ||
    !metrics ||
    Object.keys(metrics).length === 0
  ) {
    throw new Error('Invalid eval baseline manifest')
  }
  for (const [metric, rawGate] of Object.entries(metrics)) {
    const gate = record(rawGate)
    if (
      !nonempty(metric) ||
      !gate ||
      !nonnegativeInteger(gate.scoreCount) ||
      !nonnegativeInteger(gate.maximumErrorCount) ||
      (gate.minimumPassRate !== undefined &&
        (typeof gate.minimumPassRate !== 'number' ||
          gate.minimumPassRate < 0 || gate.minimumPassRate > 1)) ||
      (gate.minimumNumericMean !== undefined &&
        (typeof gate.minimumNumericMean !== 'number' ||
          !Number.isFinite(gate.minimumNumericMean)))
    ) {
      throw new Error(`Invalid eval metric gate: ${metric}`)
    }
  }
  return value as EvalBaseline
}

export function summarizeEvalReport<TOutput>(report: EvalRunReport<TOutput>): EvalReportSummary {
  const metricRecords = new Map<string, {
    scoreCount: number
    errorCount: number
    passedCount: number
    failedCount: number
    numericValues: number[]
  }>()
  let targetErrorCount = 0
  let evaluatorErrorCount = 0

  for (const trial of report.trials) {
    if (trial.status === 'error') targetErrorCount += 1
    for (const score of trial.scores) {
      const metric = metricRecords.get(score.metric) ?? {
        scoreCount: 0,
        errorCount: 0,
        passedCount: 0,
        failedCount: 0,
        numericValues: [],
      }
      metric.scoreCount += 1
      if (score.status === 'error') {
        metric.errorCount += 1
        evaluatorErrorCount += 1
      }
      if (score.passed === true) metric.passedCount += 1
      if (score.passed === false) metric.failedCount += 1
      if (score.status === 'succeeded' && score.value !== undefined) {
        metric.numericValues.push(score.value)
      }
      metricRecords.set(score.metric, metric)
    }
  }

  const metrics = Object.fromEntries(
    [...metricRecords.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        const verdictCount = value.passedCount + value.failedCount
        return [key, {
          scoreCount: value.scoreCount,
          errorCount: value.errorCount,
          passedCount: value.passedCount,
          failedCount: value.failedCount,
          passRate: verdictCount ? value.passedCount / verdictCount : null,
          numericCount: value.numericValues.length,
          numericMean: value.numericValues.length
            ? value.numericValues.reduce((sum, item) => sum + item, 0) / value.numericValues.length
            : null,
        } satisfies EvalMetricSummary]
      }),
  )

  return {
    status: report.status,
    caseKeys: [...new Set(report.trials.map((trial) => trial.caseKey))].sort(),
    trialCount: report.trials.length,
    targetErrorCount,
    evaluatorErrorCount,
    metrics,
  }
}

export function baselineFromReport<TOutput>(
  report: EvalRunReport<TOutput>,
): EvalBaseline {
  const summary = summarizeEvalReport(report)
  if (
    report.status !== 'completed' ||
    summary.targetErrorCount > 0 ||
    summary.evaluatorErrorCount > 0
  ) {
    throw new Error('Cannot create a baseline from a failed eval report')
  }
  return parseEvalBaseline({
    schemaVersion: 1,
    suite: report.suite,
    target: { key: report.target.key, version: report.target.version },
    trialsPerCase: report.trialsPerCase,
    expectedCaseKeys: summary.caseKeys,
    maximumTargetErrors: summary.targetErrorCount,
    maximumEvaluatorErrors: summary.evaluatorErrorCount,
    metrics: Object.fromEntries(
      Object.entries(summary.metrics).map(([metric, value]) => [metric, {
        scoreCount: value.scoreCount,
        maximumErrorCount: value.errorCount,
        ...(value.passRate === null ? {} : { minimumPassRate: value.passRate }),
        ...(value.numericMean === null ? {} : { minimumNumericMean: value.numericMean }),
      }]),
    ),
  })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function compareEvalBaseline<TOutput>(
  report: EvalRunReport<TOutput>,
  baseline: EvalBaseline,
): EvalBaselineComparison {
  parseEvalBaseline(baseline)
  const failures: string[] = []
  const summary = summarizeEvalReport(report)
  if (baseline.schemaVersion !== 1) failures.push('Unsupported baseline schema version')
  if (report.suite.key !== baseline.suite.key) failures.push('Suite key changed')
  if (report.suite.version !== baseline.suite.version) failures.push('Suite version changed')
  if (report.suite.datasetFingerprint !== baseline.suite.datasetFingerprint) {
    failures.push('Dataset fingerprint changed without an accepted baseline update')
  }
  if (report.target.key !== baseline.target.key) failures.push('Target key changed')
  if (report.target.version !== baseline.target.version) failures.push('Target version changed')
  if (report.trialsPerCase !== baseline.trialsPerCase) failures.push('Trials per case changed')
  if (!sameStrings(summary.caseKeys, [...baseline.expectedCaseKeys].sort())) {
    failures.push('Eval case inventory changed')
  }
  if (summary.targetErrorCount > baseline.maximumTargetErrors) {
    failures.push(`Target errors increased to ${summary.targetErrorCount}`)
  }
  if (summary.evaluatorErrorCount > baseline.maximumEvaluatorErrors) {
    failures.push(`Evaluator errors increased to ${summary.evaluatorErrorCount}`)
  }

  for (const [metric, gate] of Object.entries(baseline.metrics)) {
    const actual = summary.metrics[metric]
    if (!actual) {
      failures.push(`Required metric is missing: ${metric}`)
      continue
    }
    if (actual.scoreCount !== gate.scoreCount) {
      failures.push(`${metric} score count changed to ${actual.scoreCount}`)
    }
    if (actual.errorCount > gate.maximumErrorCount) {
      failures.push(`${metric} errors increased to ${actual.errorCount}`)
    }
    if (
      gate.minimumPassRate !== undefined &&
      (actual.passRate === null || actual.passRate < gate.minimumPassRate)
    ) {
      failures.push(`${metric} pass rate regressed to ${actual.passRate ?? 'null'}`)
    }
    if (
      gate.minimumNumericMean !== undefined &&
      (actual.numericMean === null || actual.numericMean < gate.minimumNumericMean)
    ) {
      failures.push(`${metric} numeric mean regressed to ${actual.numericMean ?? 'null'}`)
    }
  }

  return { passed: failures.length === 0, failures, summary }
}
