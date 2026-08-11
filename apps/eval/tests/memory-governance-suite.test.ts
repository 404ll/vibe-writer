import { readFileSync } from 'node:fs'
import { compareEvalBaseline, type EvalBaseline } from '@vibe-writer/eval-core'
import { describe, expect, it } from 'vitest'
import {
  memoryGovernanceEvalCases,
  runMemoryGovernanceEval,
} from '../src/memory-governance-suite'

const baseline = JSON.parse(readFileSync(
  new URL('../baselines/memory-governance-v2.json', import.meta.url),
  'utf8',
)) as EvalBaseline

describe('tracked Memory governance regression suite', () => {
  it('covers policy, rejection, dedupe, conflict, and review transitions', () => {
    const cases = memoryGovernanceEvalCases()
    expect(cases).toHaveLength(20)
    expect(new Set(cases.map(({ key }) => key)).size).toBe(20)
    expect(cases.filter(({ key }) => key.startsWith('memory-policy/'))).toHaveLength(12)
    expect(cases.filter(({ key }) => key.startsWith('memory-review/'))).toHaveLength(8)
  })

  it('passes the tracked baseline without capturing proposal content in the report', async () => {
    const { report } = await runMemoryGovernanceEval()
    expect(compareEvalBaseline(report, baseline)).toMatchObject({
      passed: true,
      failures: [],
      summary: {
        status: 'completed',
        trialCount: 20,
        targetErrorCount: 0,
        evaluatorErrorCount: 0,
        metrics: {
          memory_governance_exact_match: {
            scoreCount: 20,
            passedCount: 20,
            failedCount: 0,
            passRate: 1,
          },
        },
      },
    })
    expect(report.trials.every((trial) => !Object.hasOwn(trial, 'output'))).toBe(true)
    expect(JSON.stringify(report)).not.toContain('Prefer concise explanations')
  })
})
