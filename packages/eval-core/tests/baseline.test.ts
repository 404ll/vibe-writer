import { describe, expect, it } from 'vitest'
import {
  baselineFromReport,
  compareEvalBaseline,
  parseEvalBaseline,
  runOfflineEval,
  summarizeEvalReport,
} from '../src'

const execution = {
  modelProfile: 'scripted:model-v1',
  promptVersion: 'prompt-v1',
  graphVersion: 'graph-v1',
  toolVersions: { evaluator: 'v1' },
  codeRevision: 'revision-v1',
}

async function report() {
  return runOfflineEval(
    [
      { key: 'a', input: 1, expected: 2 },
      { key: 'b', input: 2, expected: 4 },
    ],
    { key: 'double', version: 'v1', execute: async (input) => input * 2 },
    [{
      key: 'exact', version: 'v1', metric: 'exact_match',
      evaluate: (evaluation) => ({ passed: evaluation.output === evaluation.case.expected }),
    }],
    { suite: { key: 'math', version: 'v1' }, execution },
  )
}

describe('eval baseline gate', () => {
  it('summarizes and accepts the exact registered baseline', async () => {
    const current = await report()
    expect(summarizeEvalReport(current)).toMatchObject({
      status: 'completed',
      caseKeys: ['a', 'b'],
      trialCount: 2,
      targetErrorCount: 0,
      evaluatorErrorCount: 0,
      metrics: {
        exact_match: { scoreCount: 2, passedCount: 2, passRate: 1 },
      },
    })
    expect(compareEvalBaseline(current, baselineFromReport(current))).toMatchObject({
      passed: true,
      failures: [],
    })
  })

  it('reports dataset, inventory, error, and score regressions', async () => {
    const current = await report()
    const baseline = baselineFromReport(current)
    const regressed = structuredClone(current)
    regressed.suite.datasetFingerprint = `sha256:${'0'.repeat(64)}`
    regressed.trials[0]!.caseKey = 'changed'
    regressed.trials[0]!.scores[0]!.passed = false
    regressed.trials[1]!.scores[0]!.status = 'error'
    regressed.trials[1]!.scores[0]!.errorCode = 'evaluator_error'

    const comparison = compareEvalBaseline(regressed, baseline)
    expect(comparison.passed).toBe(false)
    expect(comparison.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('Dataset fingerprint changed'),
      expect.stringContaining('case inventory changed'),
      expect.stringContaining('Evaluator errors increased'),
      expect.stringContaining('pass rate regressed'),
    ]))
    expect(() => baselineFromReport(regressed)).toThrow('failed eval report')
  })

  it('rejects under-specified or invalid baseline manifests', () => {
    expect(() => parseEvalBaseline({ schemaVersion: 1 })).toThrow('Invalid')
    expect(() => parseEvalBaseline({
      schemaVersion: 1,
      suite: { key: 'suite', version: 'v1', datasetFingerprint: `sha256:${'0'.repeat(64)}` },
      target: { key: 'target', version: 'v1' },
      trialsPerCase: 1,
      expectedCaseKeys: ['case'],
      maximumTargetErrors: 0,
      maximumEvaluatorErrors: 0,
      metrics: { score: { scoreCount: 1, maximumErrorCount: 0, minimumPassRate: 2 } },
    })).toThrow('metric gate')
  })
})
