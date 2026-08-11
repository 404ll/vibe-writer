import { describe, expect, it } from 'vitest'
import {
  scoreMemoryExtractionQuality,
  type MemoryExtractionQualityCase,
} from '../src'

const candidate = {
  subject: { kind: 'principal' as const, key: 'self' },
  memoryKey: 'writing.tone',
  kind: 'preference' as const,
  content: 'Prefer concise technical prose.',
  confidence: 0.95,
  sensitivity: 'normal' as const,
}

function qualityCase(
  key: string,
  category: MemoryExtractionQualityCase['category'],
  shouldWrite: boolean,
): MemoryExtractionQualityCase {
  return {
    key,
    category,
    input: {
      segments: [{
        id: `${key}-segment`,
        author: category === 'assistant_generated' ? 'assistant' : 'user',
        scope: category === 'task_instruction' ? 'task' : 'durable',
        text: `Synthetic ${key}`,
      }],
    },
    expected: {
      shouldWrite,
      candidates: shouldWrite ? [candidate] : [],
    },
  }
}

describe('Memory extraction corpus metrics', () => {
  it('computes perfect corpus-level precision, recall, slot, and leak metrics', () => {
    const cases = [
      qualityCase('positive', 'durable_preference', true),
      qualityCase('task', 'task_instruction', false),
      qualityCase('assistant', 'assistant_generated', false),
      qualityCase('sensitive', 'sensitive_trap', false),
    ]
    expect(scoreMemoryExtractionQuality({
      cases,
      outputs: {
        positive: { schemaVersion: 1, candidates: [candidate] },
        task: { schemaVersion: 1, candidates: [] },
        assistant: { schemaVersion: 1, candidates: [] },
        sensitive: { schemaVersion: 1, candidates: [] },
      },
    })).toEqual({
      caseCount: 4,
      validOutputCount: 4,
      invalidOutputCount: 0,
      truePositiveCount: 1,
      falsePositiveCount: 0,
      falseNegativeCount: 0,
      trueNegativeCount: 3,
      shouldWritePrecision: 1,
      shouldWriteRecall: 1,
      shouldWriteAccuracy: 1,
      slotExactCount: 1,
      positiveCaseCount: 1,
      slotExactRate: 1,
      candidateExactCount: 1,
      candidateExactRate: 1,
      taskLeakCount: 0,
      assistantLeakCount: 0,
      sensitiveLeakCount: 0,
    })
  })

  it('penalizes false positives, false negatives, invalid output, and sensitive leakage', () => {
    const cases = [
      qualityCase('missed-positive', 'durable_preference', true),
      qualityCase('invalid-negative', 'ambiguous', false),
      qualityCase('sensitive-leak', 'sensitive_trap', false),
    ]
    const metrics = scoreMemoryExtractionQuality({
      cases,
      outputs: {
        'missed-positive': { schemaVersion: 1, candidates: [] },
        'invalid-negative': { not: 'the contract' },
        'sensitive-leak': { schemaVersion: 1, candidates: [candidate] },
      },
    })
    expect(metrics).toMatchObject({
      validOutputCount: 2,
      invalidOutputCount: 1,
      truePositiveCount: 0,
      falsePositiveCount: 2,
      falseNegativeCount: 1,
      trueNegativeCount: 0,
      shouldWritePrecision: 0,
      shouldWriteRecall: 0,
      shouldWriteAccuracy: 0,
      sensitiveLeakCount: 1,
    })
  })

  it('requires an exact one-to-one case/output inventory', () => {
    const cases = [qualityCase('only', 'durable_preference', true)]
    expect(() => scoreMemoryExtractionQuality({ cases, outputs: {} })).toThrow(
      'outputs must match',
    )
    expect(() => scoreMemoryExtractionQuality({
      cases,
      outputs: {
        only: { schemaVersion: 1, candidates: [candidate] },
        extra: { schemaVersion: 1, candidates: [] },
      },
    })).toThrow('outputs must match')
  })
})
