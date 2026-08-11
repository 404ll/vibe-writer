import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  evaluateMemoryCalibrationReadiness,
  readTrackedMemoryCalibrationReadiness,
} from '../src/memory-calibration-readiness'

const plan = JSON.parse(readFileSync(
  new URL('../manifests/memory-calibration-v1.json', import.meta.url),
  'utf8',
))
const baseline = JSON.parse(readFileSync(
  new URL('../baselines/memory-extraction-quality-v1.json', import.meta.url),
  'utf8',
))

describe('Memory live calibration readiness', () => {
  it('tracks a verified No-Go until model, pricing, live trials, and resolver evidence exist', () => {
    expect(readTrackedMemoryCalibrationReadiness()).toMatchObject({
      status: 'no_go',
      productionEligible: false,
      automaticUncertainResolutionEligible: false,
      dataset: { caseCount: 24, fingerprint: baseline.evalBaseline.suite.datasetFingerprint },
      runPolicy: { trialsPerCase: 3, maxCalls: 72, captureOutput: false },
      blockers: [
        'model_unselected',
        'pricing_snapshot_unbound',
        'live_trials_missing',
        'request_level_terminal_lookup_unavailable',
      ],
    })
  })

  it('rejects an attempted production enablement without calibration', () => {
    expect(() => evaluateMemoryCalibrationReadiness({
      plan: { ...plan, decision: { ...plan.decision, productionEligible: true } },
      baseline,
    })).toThrow('remain fail closed')
  })

  it('rejects stale datasets and incomplete trial budgets', () => {
    expect(() => evaluateMemoryCalibrationReadiness({
      plan: { ...plan, dataset: { ...plan.dataset, fingerprint: `sha256:${'f'.repeat(64)}` } },
      baseline,
    })).toThrow('does not match')
    expect(() => evaluateMemoryCalibrationReadiness({
      plan: { ...plan, runPolicy: { ...plan.runPolicy, maxCalls: 71 } },
      baseline,
    })).toThrow('exact trial inventory')
  })

  it('rejects non-official capability evidence and missing blockers', () => {
    expect(() => evaluateMemoryCalibrationReadiness({
      plan: {
        ...plan,
        providerCapabilityAudit: {
          ...plan.providerCapabilityAudit,
          sources: ['https://example.com/provider-docs'],
        },
      },
      baseline,
    })).toThrow('official sources')
    expect(() => evaluateMemoryCalibrationReadiness({
      plan: { ...plan, decision: { ...plan.decision, blockers: ['model_unselected'] } },
      baseline,
    })).toThrow('blocker is missing')
  })
})
