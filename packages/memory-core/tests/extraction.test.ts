import { describe, expect, it } from 'vitest'
import {
  MEMORY_EXTRACTION_CONTRACT,
  composeModelMemoryProposals,
} from '../src/extraction'

const envelope = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  source: {
    kind: 'run',
    runId: '20000000-0000-4000-8000-000000000002',
    evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
  },
  extractor: { key: 'writing-memory-extractor', version: 'v1' },
  consent: { basis: 'workspace_policy', policyVersion: 'memory-consent-v1' },
  expiresAt: '2026-09-07T00:00:00.000Z',
} as const

function output(candidates: unknown[]) {
  return { schemaVersion: 1, candidates }
}

const candidate = {
  subject: { kind: 'workspace', key: 'default' },
  memoryKey: 'writing.tone',
  kind: 'preference',
  content: 'Prefer concise technical prose.',
  confidence: 0.95,
  sensitivity: 'normal',
} as const

describe('trusted-envelope Memory extraction contract', () => {
  it('composes model fields with trusted workspace, provenance, consent, and retention', () => {
    expect(composeModelMemoryProposals({
      envelope,
      modelOutput: output([candidate]),
    })).toEqual([{
      schemaVersion: 2,
      workspaceId: envelope.workspaceId,
      subject: candidate.subject,
      memoryKey: candidate.memoryKey,
      kind: candidate.kind,
      content: candidate.content,
      proposedBy: 'model',
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      consent: envelope.consent,
      source: envelope.source,
      extractor: envelope.extractor,
      expiresAt: envelope.expiresAt,
    }])
  })

  it('rejects attempts by model output to control trusted fields', () => {
    for (const field of ['workspaceId', 'source', 'consent', 'expiresAt', 'proposedBy']) {
      expect(() => composeModelMemoryProposals({
        envelope,
        modelOutput: output([{ ...candidate, [field]: 'forged' }]),
      })).toThrow()
    }
  })

  it('rejects duplicate slots within one extraction batch', () => {
    expect(() => composeModelMemoryProposals({
      envelope,
      modelOutput: output([candidate, { ...candidate, content: 'A conflicting value.' }]),
    })).toThrow('duplicate slot')
  })

  it('enforces a bounded batch and strict candidate schema', () => {
    expect(() => composeModelMemoryProposals({
      envelope,
      modelOutput: output(Array.from(
        { length: MEMORY_EXTRACTION_CONTRACT.maximumCandidatesPerRun + 1 },
        (_, index) => ({ ...candidate, memoryKey: `writing.preference-${index}` }),
      )),
    })).toThrow()
    expect(() => composeModelMemoryProposals({
      envelope,
      modelOutput: output([{ ...candidate, confidence: 2 }]),
    })).toThrow()
  })

  it('fails closed for invalid trusted provenance and supports an empty batch', () => {
    expect(() => composeModelMemoryProposals({
      envelope: { ...envelope, source: { ...envelope.source, runId: 'not-a-uuid' } },
      modelOutput: output([]),
    })).toThrow()
    expect(composeModelMemoryProposals({ envelope, modelOutput: output([]) })).toEqual([])
  })

  it('preserves a trusted signal source', () => {
    const signalEnvelope = {
      ...envelope,
      source: {
        kind: 'signal' as const,
        signalId: '30000000-0000-4000-8000-000000000003',
        evidenceFingerprint: `sha256:${'b'.repeat(64)}`,
      },
      subject: { kind: 'principal' as const, key: 'principal-1' },
      consent: { basis: 'explicit_user' as const, policyVersion: 'memory-consent-v1' },
    }
    expect(composeModelMemoryProposals({
      envelope: signalEnvelope,
      modelOutput: output([candidate]),
    })[0]).toMatchObject({
      schemaVersion: 2,
      source: signalEnvelope.source,
      subject: signalEnvelope.subject,
    })
  })
})
