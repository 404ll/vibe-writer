import { readFileSync } from 'node:fs'
import { compareEvalBaseline, type EvalBaseline } from '@vibe-writer/eval-core'
import { describe, expect, it } from 'vitest'
import {
  componentEvalCases,
  runComponentRegressionEval,
} from '../src/component-suite'

const baseline = JSON.parse(readFileSync(
  new URL('../baselines/component-regression-v1.json', import.meta.url),
  'utf8',
)) as EvalBaseline

describe('tracked component regression suite', () => {
  it('covers every registered fixture group with unique stable keys', () => {
    const cases = componentEvalCases()
    expect(cases).toHaveLength(38)
    expect(new Set(cases.map((item) => item.key))).toHaveProperty('size', 38)
    expect(new Set(cases.flatMap((item) => item.tags ?? []))).toEqual(new Set([
      'agent-component-baseline-v1',
      'planner-outline',
      'planner-trim',
      'json-object',
      'reviewer-output',
      'opinion-search-baseline-v1',
      'coverage-output',
      'search-policy',
      'search-ranking',
      'writer-tool-baseline-v1',
      'writer-tool-loop',
    ]))
  })

  it('passes the tracked baseline without persisting fixture contents', async () => {
    const { report } = await runComponentRegressionEval()
    expect(compareEvalBaseline(report, baseline)).toMatchObject({
      passed: true,
      failures: [],
      summary: {
        status: 'completed',
        trialCount: 38,
        targetErrorCount: 0,
        evaluatorErrorCount: 0,
        metrics: {
          exact_match: {
            scoreCount: 38,
            passedCount: 38,
            failedCount: 0,
            passRate: 1,
          },
        },
      },
    })
    expect(report.trials.every((trial) => !Object.hasOwn(trial, 'output'))).toBe(true)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('API secret detail')
    expect(serialized).not.toContain('fixture user')
  })
})
