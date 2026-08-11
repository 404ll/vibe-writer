import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MEMORY_POLICY,
  evaluateMemoryProposal,
  fingerprintMemoryContent,
  planMemoryReviewTransition,
} from '../src/policy'

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    workspaceId: '10000000-0000-4000-8000-000000000001',
    subject: { kind: 'principal' as const, key: 'principal-1' },
    memoryKey: 'writing.tone',
    kind: 'preference',
    content: ' Prefer concise explanations. ',
    proposedBy: 'model',
    confidence: 0.9,
    sensitivity: 'normal',
    consent: { basis: 'workspace_policy', policyVersion: 'memory-policy-v1' },
    source: {
      kind: 'run',
      runId: randomUUID(),
      evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
    },
    extractor: { key: 'memory-extractor', version: 'v1' },
    expiresAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  }
}

const now = new Date('2026-08-07T00:00:00.000Z')

describe('versioned Memory policy kernel', () => {
  it('normalizes an eligible proposal into a review candidate', () => {
    expect(evaluateMemoryProposal({ proposal: proposal(), now })).toMatchObject({
      outcome: 'candidate',
      proposal: { content: 'Prefer concise explanations.' },
      contentFingerprint: fingerprintMemoryContent('Prefer concise explanations.'),
    })
  })

  it.each([
    [{ proposedBy: 'model', sensitivity: 'sensitive' }, 'sensitive_inference'],
    [{ proposedBy: 'model', confidence: MEMORY_POLICY.minimumModelConfidence - 0.01 }, 'low_confidence'],
    [{ expiresAt: now.toISOString() }, 'expired'],
  ])('rejects unsafe proposal %j with %s', (overrides, reason) => {
    expect(evaluateMemoryProposal({ proposal: proposal(overrides), now })).toMatchObject({
      outcome: 'rejected', reason,
    })
  })

  it('classifies exact replay as duplicate and a changed slot value as conflict', () => {
    const base = proposal()
    const activeMemory = {
      workspaceId: base.workspaceId,
      subject: base.subject,
      memoryKey: base.memoryKey,
      contentFingerprint: fingerprintMemoryContent(String(base.content)),
    } as const
    expect(evaluateMemoryProposal({ proposal: base, now, activeMemory })).toMatchObject({
      outcome: 'duplicate',
    })
    expect(evaluateMemoryProposal({
      proposal: proposal({ content: 'Prefer detailed explanations.' }),
      now,
      activeMemory,
    })).toMatchObject({ outcome: 'conflict' })
  })

  it('rejects unknown fields and cross-slot comparisons', () => {
    expect(() => evaluateMemoryProposal({
      proposal: proposal({ secretExtraField: true }), now,
    })).toThrow()
    expect(() => evaluateMemoryProposal({
      proposal: proposal(), now,
      activeMemory: {
        workspaceId: '20000000-0000-4000-8000-000000000002',
        subject: { kind: 'principal', key: 'principal-1' },
        memoryKey: 'writing.tone',
        contentFingerprint: fingerprintMemoryContent('Prefer concise explanations.'),
      },
    })).toThrow('does not belong')
  })

  it('plans explicit create and conflict replacement revisions', () => {
    const fingerprint = fingerprintMemoryContent('Prefer concise explanations.')
    expect(planMemoryReviewTransition({
      candidate: { policyOutcome: 'candidate', kind: 'preference', contentFingerprint: fingerprint },
    })).toEqual({ outcome: 'create', revision: 1 })
    expect(planMemoryReviewTransition({
      candidate: { policyOutcome: 'conflict', kind: 'preference', contentFingerprint: fingerprint },
      activeMemory: {
        id: '10000000-0000-4000-8000-000000000010',
        kind: 'preference',
        currentRevision: 4,
      },
      replaceMemoryId: '10000000-0000-4000-8000-000000000010',
    })).toEqual({
      outcome: 'replace',
      memoryId: '10000000-0000-4000-8000-000000000010',
      revision: 5,
    })
  })

  it.each([
    [
      {
        candidate: {
          policyOutcome: 'candidate',
          kind: 'preference',
          contentFingerprint: `sha256:${'b'.repeat(64)}`,
        },
        activeMemory: {
          id: '10000000-0000-4000-8000-000000000010',
          kind: 'preference',
          currentRevision: 1,
        },
      },
      'stale_candidate',
    ],
    [
      {
        candidate: {
          policyOutcome: 'conflict',
          kind: 'preference',
          contentFingerprint: `sha256:${'b'.repeat(64)}`,
        },
      },
      'replacement_required',
    ],
    [
      {
        candidate: {
          policyOutcome: 'conflict',
          kind: 'constraint',
          contentFingerprint: `sha256:${'b'.repeat(64)}`,
        },
        activeMemory: {
          id: '10000000-0000-4000-8000-000000000010',
          kind: 'preference',
          currentRevision: 1,
        },
        replaceMemoryId: '10000000-0000-4000-8000-000000000010',
      },
      'kind_mismatch',
    ],
  ])('fails closed for invalid review transition %#', (input, reason) => {
    expect(planMemoryReviewTransition(input)).toEqual({ outcome: 'rejected', reason })
  })
})
