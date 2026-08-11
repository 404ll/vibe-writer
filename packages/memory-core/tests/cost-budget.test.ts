import { describe, expect, it } from 'vitest'
import {
  estimateMemoryExtractionMaximumCost,
  MemoryExtractionBudgetPolicySchema,
  memoryModelUsageCost,
} from '../src'

const policy = {
  policyVersion: 'memory-budget-2026-08-07-v1',
  maxSourceCostMicrousd: 5_000,
  maxWorkspaceDailyCostMicrousd: 50_000,
  maxOutputTokens: 500,
  pricing: {
    version: 'scripted-pricing-v1',
    inputMicrousdPerMillionTokens: 3_000,
    outputMicrousdPerMillionTokens: 15_000,
    cacheReadMicrousdPerMillionTokens: 300,
    cacheWriteMicrousdPerMillionTokens: 3_750,
  },
}

describe('Memory extraction cost budget contract', () => {
  it('reserves conservatively from UTF-8 bytes and the maximum output', () => {
    expect(estimateMemoryExtractionMaximumCost({
      inputUtf8Bytes: 1_000,
      policy,
    })).toBe(16)
  })

  it('prices provider usage with an immutable pricing snapshot', () => {
    expect(memoryModelUsageCost({
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheWriteInputTokens: 100,
      },
      pricing: policy.pricing,
    })).toBe(13)
  })

  it('rejects unknown fields and a source cap above the workspace daily cap', () => {
    expect(() => MemoryExtractionBudgetPolicySchema.parse({
      ...policy,
      maxSourceCostMicrousd: 50_001,
      unexpected: true,
    })).toThrow()
    expect(() => estimateMemoryExtractionMaximumCost({
      inputUtf8Bytes: -1,
      policy,
    })).toThrow()
  })
})
