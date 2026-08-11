import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  durableMemoryManagementApiEnabled,
  durableMemorySignalApiEnabled,
  getDurableDatabaseUrl,
  getMemoryConsentPolicy,
  getMemoryConsentPolicyVersion,
} from './durableDatabase'

describe('durable database configuration', () => {
  it('requires the dedicated API role and never falls back to an owner URL', () => {
    expect(getDurableDatabaseUrl({
      DATABASE_API_URL: '  postgresql://api@db/vibe  ',
    })).toBe('postgresql://api@db/vibe')
    expect(() => getDurableDatabaseUrl({ DATABASE_API_URL: '' }))
      .toThrow('DATABASE_API_URL is required')
  })
})

describe('durable Memory signal configuration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('stays disabled unless the feature flag is exactly true', () => {
    vi.stubEnv('DURABLE_MEMORY_SIGNAL_API_ENABLED', 'false')
    expect(durableMemorySignalApiEnabled()).toBe(false)
    vi.stubEnv('DURABLE_MEMORY_SIGNAL_API_ENABLED', 'true')
    expect(durableMemorySignalApiEnabled()).toBe(true)
    vi.stubEnv('DURABLE_MEMORY_MANAGEMENT_API_ENABLED', 'false')
    expect(durableMemoryManagementApiEnabled()).toBe(false)
    vi.stubEnv('DURABLE_MEMORY_MANAGEMENT_API_ENABLED', 'true')
    expect(durableMemoryManagementApiEnabled()).toBe(true)
  })

  it('accepts only versions present in the immutable consent policy registry', () => {
    vi.stubEnv('MEMORY_CONSENT_POLICY_VERSION', 'memory-consent-v1')
    expect(getMemoryConsentPolicyVersion()).toBe('memory-consent-v1')
    expect(getMemoryConsentPolicy()).toMatchObject({
      schema_version: 1,
      version: 'memory-consent-v1',
      retention: { default_days: 30 },
    })
    vi.stubEnv('MEMORY_CONSENT_POLICY_VERSION', 'memory-consent-v2')
    expect(getMemoryConsentPolicyVersion()).toBeNull()
    vi.stubEnv('MEMORY_CONSENT_POLICY_VERSION', 'human readable policy')
    expect(getMemoryConsentPolicyVersion()).toBeNull()
    vi.stubEnv('MEMORY_CONSENT_POLICY_VERSION', '')
    expect(getMemoryConsentPolicyVersion()).toBeNull()
  })
})
