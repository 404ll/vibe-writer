import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  apiEnabled: vi.fn(),
  managementEnabled: vi.fn(),
  signalsEnabled: vi.fn(),
  policy: vi.fn(),
  authorize: vi.fn(),
}))

vi.mock('@/server/database/durableDatabase', () => ({
  durableApiEnabled: durable.apiEnabled,
  durableMemoryManagementApiEnabled: durable.managementEnabled,
  durableMemorySignalApiEnabled: durable.signalsEnabled,
  getMemoryConsentPolicy: durable.policy,
  authorizeDurableHeaders: durable.authorize,
}))

import { GET } from './route'

const policy = {
  schema_version: 1,
  version: 'memory-consent-v1',
  title: '长期记忆使用说明',
  summary: '仅保存明确提交的内容。',
  statements: [{
    key: 'explicit-consent',
    title: '明确提交',
    description: '提交前展示当前版本。',
  }],
  retention: { minimum_days: 1, default_days: 30, maximum_days: 365 },
  allowed_signal_kinds: ['explicit_remember', 'preference_setting', 'correction'],
}

describe('durable Memory policy route', () => {
  beforeEach(() => {
    for (const mock of Object.values(durable)) mock.mockReset()
    durable.apiEnabled.mockReturnValue(true)
    durable.managementEnabled.mockReturnValue(true)
    durable.signalsEnabled.mockReturnValue(true)
    durable.policy.mockReturnValue(policy)
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role: 'viewer',
        authorization: 'verified-membership',
      },
    })
  })

  it('fails closed when features or the registered policy are unavailable', async () => {
    durable.managementEnabled.mockReturnValue(false)
    durable.signalsEnabled.mockReturnValue(false)
    expect((await GET(new Request('http://localhost'))).status).toBe(503)
    expect(durable.authorize).not.toHaveBeenCalled()

    durable.managementEnabled.mockReturnValue(true)
    durable.policy.mockReturnValue(null)
    const unregistered = await GET(new Request('http://localhost'))
    expect(unregistered.status).toBe(503)
    await expect(unregistered.json()).resolves.toEqual({
      detail: 'Durable Memory consent policy is not registered.',
    })
  })

  it('returns registered policy copy and server-derived viewer capabilities', async () => {
    const response = await GET(new Request('http://localhost'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      policy: { version: 'memory-consent-v1', retention: { default_days: 30 } },
      workspace: {
        role: 'viewer',
        capabilities: {
          read_active_memories: true,
          review_candidates: false,
          delete_active_memories: false,
          manage_own_signals: true,
          create_shared_signals: false,
        },
        signal_subjects: [{ label: '仅自己' }],
      },
    })
  })
})
