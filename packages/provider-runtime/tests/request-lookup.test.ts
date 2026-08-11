import { describe, expect, it } from 'vitest'
import {
  fingerprintProviderLookupEvidence,
  ProviderRequestLookupResultSchema,
  ScriptedProviderRequestLookup,
} from '../src/request-lookup'

const succeeded = {
  status: 'succeeded' as const,
  provider: 'scripted',
  model: 'memory-v1',
  requestId: 'request-1',
  evidenceFingerprint: `sha256:${'a'.repeat(64)}`,
  usage: {
    inputTokens: 12,
    outputTokens: 3,
    cacheReadInputTokens: 2,
  },
}

describe('provider request lookup contract', () => {
  it('returns strict terminal evidence without provider output content', async () => {
    const lookup = new ScriptedProviderRequestLookup({
      provider: 'scripted',
      records: { 'request-1': succeeded },
    })
    await expect(lookup.lookup({
      provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
    })).resolves.toEqual(succeeded)
    expect(JSON.stringify(succeeded)).not.toContain('content')
  })

  it('keeps absence unresolved instead of converting it to failure', async () => {
    const lookup = new ScriptedProviderRequestLookup({ provider: 'scripted', records: {} })
    await expect(lookup.lookup({
      provider: 'scripted', model: 'memory-v1', requestId: 'missing',
    })).resolves.toEqual({
      status: 'not_found', provider: 'scripted', model: 'memory-v1', requestId: 'missing',
    })
  })

  it('rejects response identity drift and unknown fields', async () => {
    const lookup = new ScriptedProviderRequestLookup({
      provider: 'scripted',
      records: { 'request-1': { ...succeeded, model: 'other-model' } },
    })
    await expect(lookup.lookup({
      provider: 'scripted', model: 'memory-v1', requestId: 'request-1',
    })).rejects.toThrow('identity collision')
    expect(ProviderRequestLookupResultSchema.safeParse({ ...succeeded, output: 'secret' }).success)
      .toBe(false)
  })

  it('creates deterministic evidence fingerprints from normalized records', () => {
    const first = fingerprintProviderLookupEvidence(succeeded)
    const second = fingerprintProviderLookupEvidence({
      ...succeeded,
      usage: { cacheReadInputTokens: 2, outputTokens: 3, inputTokens: 12 },
    })
    expect(first).toBe(second)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
