import { createHash } from 'node:crypto'
import {
  compareEvalBaseline,
  summarizeEvalReport,
  type EvalBaseline,
  type EvalRunReport,
} from '@vibe-writer/eval-core'

export type EvalCiIdentity = {
  codeRevision: string
  runId: string
  runAttempt: string
  generatedAt: string
}

function required(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new Error(`${name} is required`)
  return normalized
}

export function contentFreeEvalResult(
  report: EvalRunReport<unknown>,
  baseline: EvalBaseline,
) {
  const comparison = compareEvalBaseline(report, baseline)
  const summary = summarizeEvalReport(report)
  return {
    status: comparison.passed ? 'passed' as const : 'failed' as const,
    suite: report.suite,
    target: {
      key: report.target.key,
      version: report.target.version,
      execution: report.target.execution,
    },
    trialsPerCase: report.trialsPerCase,
    comparison: {
      failures: comparison.failures,
      baseline: {
        schemaVersion: baseline.schemaVersion,
        suite: baseline.suite,
        target: baseline.target,
      },
    },
    summary: {
      status: summary.status,
      caseCount: summary.caseKeys.length,
      trialCount: summary.trialCount,
      targetErrorCount: summary.targetErrorCount,
      evaluatorErrorCount: summary.evaluatorErrorCount,
      metrics: summary.metrics,
    },
  }
}

export function createEvalCiArtifact(
  identity: EvalCiIdentity,
  results: Record<string, ReturnType<typeof contentFreeEvalResult>>,
) {
  if (Object.keys(results).length === 0) throw new Error('At least one Eval result is required')
  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date(identity.generatedAt).toISOString(),
    ci: {
      codeRevision: required(identity.codeRevision, 'codeRevision'),
      runId: required(identity.runId, 'runId'),
      runAttempt: required(identity.runAttempt, 'runAttempt'),
    },
    status: Object.values(results).every((result) => result.status === 'passed')
      ? 'passed' as const
      : 'failed' as const,
    results,
  }
  return {
    ...payload,
    payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  }
}
