import { describe, expect, it } from 'vitest'
import {
  fingerprintEvalModelExecutionBinding,
  parseEvalModelExecutionBinding,
} from '../src/model-execution'

const binding = {
  schemaVersion: 1,
  planKey: 'memory-extraction-live-calibration',
  datasetFingerprint: `sha256:${'a'.repeat(64)}`,
  target: {
    provider: 'anthropic',
    model: 'model-v1',
    modelProfile: 'profile-v1',
    promptVersion: 'prompt-v1',
    extractorVersion: 'extractor-v1',
    codeRevision: 'revision-v1',
  },
  generation: { maxOutputTokens: 256 },
  pricing: {
    version: 'pricing-v1',
    inputMicrousdPerMillionTokens: 1,
    outputMicrousdPerMillionTokens: 2,
    cacheReadMicrousdPerMillionTokens: 0,
    cacheWriteMicrousdPerMillionTokens: 1,
  },
  budget: { maxCalls: 72, maxCostMicrousd: 100 },
}

describe('Eval model execution binding', () => {
  it('normalizes a strict versioned binding and produces a stable fingerprint', () => {
    expect(parseEvalModelExecutionBinding(binding)).toEqual(binding)
    expect(fingerprintEvalModelExecutionBinding(binding)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(fingerprintEvalModelExecutionBinding({
      ...binding,
      target: { ...binding.target, model: 'model-v2' },
    })).not.toBe(fingerprintEvalModelExecutionBinding(binding))
  })

  it('rejects unknown fields, invalid pricing, and incomplete call budgets', () => {
    expect(() => parseEvalModelExecutionBinding({ ...binding, extra: true }))
      .toThrow('invalid field inventory')
    expect(() => parseEvalModelExecutionBinding({
      ...binding,
      pricing: { ...binding.pricing, outputMicrousdPerMillionTokens: -1 },
    })).toThrow('non-negative')
    expect(() => parseEvalModelExecutionBinding({
      ...binding,
      budget: { ...binding.budget, maxCalls: 0 },
    })).toThrow('must be positive')
  })
})
