import { readFileSync } from 'node:fs'
import type { MemoryExtractionOutput } from '@vibe-writer/memory-core'
import { describe, expect, it } from 'vitest'
import { memoryExtractionQualityCases } from '../src/memory-extraction-dataset'
import {
  compareMemoryExtractionBaseline,
  parseMemoryExtractionBaseline,
  runMemoryExtractionQualityEval,
  type MemoryExtractionTarget,
} from '../src/memory-extraction-suite'

const baseline = parseMemoryExtractionBaseline(JSON.parse(readFileSync(
  new URL('../baselines/memory-extraction-quality-v1.json', import.meta.url),
  'utf8',
)))

describe('provenance-aware Memory extraction quality suite', () => {
  it('tracks a unique bilingual inventory with positive and adversarial categories', () => {
    const cases = memoryExtractionQualityCases()
    expect(cases).toHaveLength(24)
    expect(new Set(cases.map(({ key }) => key)).size).toBe(24)
    expect(cases.filter(({ expected }) => expected.shouldWrite)).toHaveLength(10)
    expect(cases.filter(({ expected }) => !expected.shouldWrite)).toHaveLength(14)
    expect(cases.filter(({ category }) => category === 'task_instruction')).toHaveLength(3)
    expect(cases.filter(({ category }) => category === 'assistant_generated')).toHaveLength(3)
    expect(cases.filter(({ category }) => category === 'sensitive_trap')).toHaveLength(3)
    expect(cases.filter(({ category }) => category === 'ambiguous')).toHaveLength(5)
  })

  it('passes the tracked harness baseline with perfect corpus quality', async () => {
    const result = await runMemoryExtractionQualityEval()
    expect(compareMemoryExtractionBaseline({ ...result, baseline })).toMatchObject({
      passed: true,
      failures: [],
      summary: {
        status: 'completed',
        trialCount: 24,
        targetErrorCount: 0,
        evaluatorErrorCount: 0,
      },
      quality: {
        caseCount: 24,
        validOutputCount: 24,
        invalidOutputCount: 0,
        truePositiveCount: 10,
        falsePositiveCount: 0,
        falseNegativeCount: 0,
        trueNegativeCount: 14,
        shouldWritePrecision: 1,
        shouldWriteRecall: 1,
        shouldWriteAccuracy: 1,
        slotExactRate: 1,
        taskLeakCount: 0,
        assistantLeakCount: 0,
        sensitiveLeakCount: 0,
      },
    })
  })

  it('fails closed when a target writes every negative case', async () => {
    const leakingTarget: MemoryExtractionTarget = {
      key: 'leaking-memory-extractor',
      version: 'test-v1',
      async execute(): Promise<MemoryExtractionOutput> {
        return {
          schemaVersion: 1,
          candidates: [{
            subject: { kind: 'principal', key: 'self' },
            memoryKey: 'writing.leak',
            kind: 'preference',
            content: 'Leaked candidate.',
            confidence: 0.95,
            sensitivity: 'normal',
          }],
        }
      },
    }
    const result = await runMemoryExtractionQualityEval(leakingTarget)
    const comparison = compareMemoryExtractionBaseline({ ...result, baseline: {
      ...baseline,
      evalBaseline: {
        ...baseline.evalBaseline,
        target: { key: leakingTarget.key, version: leakingTarget.version },
      },
    } })
    expect(comparison.passed).toBe(false)
    expect(comparison.quality).toMatchObject({
      falsePositiveCount: 14,
      taskLeakCount: 3,
      assistantLeakCount: 3,
      sensitiveLeakCount: 3,
    })
    expect(comparison.failures).toContain('Task instruction leaks increased to 3')
    expect(comparison.failures).toContain('Assistant-generated leaks increased to 3')
    expect(comparison.failures).toContain('Sensitive memory leaks increased to 3')
  })
})
