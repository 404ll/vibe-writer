import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  apiEnabled: vi.fn(),
  managementEnabled: vi.fn(),
  signalsEnabled: vi.fn(),
  policy: vi.fn(),
  authorize: vi.fn(),
  listActive: vi.fn(),
  listSignals: vi.fn(),
  listCandidates: vi.fn(),
}))

vi.mock('./durableDatabase', () => ({
  durableApiEnabled: durable.apiEnabled,
  durableMemoryManagementApiEnabled: durable.managementEnabled,
  durableMemorySignalApiEnabled: durable.signalsEnabled,
  getMemoryConsentPolicy: durable.policy,
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    memory: {
      listPage: durable.listActive,
      listCandidatesPage: durable.listCandidates,
    },
    memorySourceSignals: { listOwnPage: durable.listSignals },
  }),
}))

vi.mock('./durableMemoryManagement', () => ({
  toActiveMemory: (value: unknown) => value,
  toMemoryCandidate: (value: unknown) => value,
}))
vi.mock('./durableMemorySignals', () => ({
  toMemorySignal: (value: unknown) => value,
}))
vi.mock('./durableCursor', () => ({
  encodeDurableUuidCursor: ({ id }: { id: string }) => `cursor:${id}`,
}))

import { loadMemoryManagementPageData } from './memoryManagementPageData'

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

describe('Memory management page data', () => {
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
        role: 'editor',
        authorization: 'verified-membership',
      },
    })
    durable.listActive.mockResolvedValue({ items: [], nextCursor: null })
    durable.listSignals.mockResolvedValue({ items: [], nextCursor: null })
    durable.listCandidates.mockResolvedValue({ items: [], nextCursor: null })
  })

  it('stops before authorization and repositories when management is disabled', async () => {
    durable.managementEnabled.mockReturnValue(false)
    await expect(loadMemoryManagementPageData(new Headers())).resolves.toEqual({
      status: 'disabled',
    })
    expect(durable.authorize).not.toHaveBeenCalled()
    expect(durable.listActive).not.toHaveBeenCalled()
  })

  it('loads independent first pages together and preserves editor capabilities', async () => {
    const result = await loadMemoryManagementPageData(new Headers())
    expect(result).toMatchObject({
      status: 'ready',
      data: {
        policy: { version: 'memory-consent-v1' },
        workspace: {
          role: 'editor',
          capabilities: {
            review_candidates: true,
            delete_active_memories: false,
          },
        },
        active: { memories: [], next_cursor: null },
        signals: { signals: [], next_cursor: null },
        candidates: { candidates: [], next_cursor: null },
      },
    })
    expect(durable.listActive).toHaveBeenCalledWith({ limit: 50 })
    expect(durable.listSignals).toHaveBeenCalledWith({ limit: 50 })
    expect(durable.listCandidates).toHaveBeenCalledWith({ limit: 50 })
  })

  it('does not query protected collections for a viewer or disabled signal feature', async () => {
    durable.signalsEnabled.mockReturnValue(false)
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role: 'viewer',
        authorization: 'verified-membership',
      },
    })
    const result = await loadMemoryManagementPageData(new Headers())
    expect(result).toMatchObject({
      status: 'ready',
      data: { workspace: { role: 'viewer' } },
    })
    expect(durable.listSignals).not.toHaveBeenCalled()
    expect(durable.listCandidates).not.toHaveBeenCalled()
  })
})
