import { describe, expect, it } from 'vitest'
import { createMemoryPolicyAccess } from './durableMemoryAccess'
import { getRegisteredMemoryConsentPolicy } from './memoryConsentPolicies'

const policy = getRegisteredMemoryConsentPolicy('memory-consent-v1')!
const baseScope = {
  principalId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  authorization: 'verified-membership' as const,
}

describe('Memory policy access projection', () => {
  it('lets viewers manage only their own explicit signals', () => {
    const access = createMemoryPolicyAccess({
      policy,
      scope: { ...baseScope, role: 'viewer' },
      managementEnabled: true,
      signalsEnabled: true,
    })
    expect(access.workspace.capabilities).toEqual({
      read_active_memories: true,
      review_candidates: false,
      delete_active_memories: false,
      manage_own_signals: true,
      create_shared_signals: false,
    })
    expect(access.workspace.signal_subjects).toEqual([{
      subject: { kind: 'principal', key: baseScope.principalId },
      label: '仅自己',
    }])
  })

  it('adds shared targets for editors and erasure only for owners', () => {
    const editor = createMemoryPolicyAccess({
      policy,
      scope: { ...baseScope, role: 'editor' },
      managementEnabled: true,
      signalsEnabled: true,
    })
    expect(editor.workspace.capabilities).toMatchObject({
      review_candidates: true,
      delete_active_memories: false,
      create_shared_signals: true,
    })
    expect(editor.workspace.signal_subjects).toHaveLength(2)

    const owner = createMemoryPolicyAccess({
      policy,
      scope: { ...baseScope, role: 'owner' },
      managementEnabled: true,
      signalsEnabled: false,
    })
    expect(owner.workspace.capabilities.delete_active_memories).toBe(true)
    expect(owner.workspace.capabilities.manage_own_signals).toBe(false)
    expect(owner.workspace.signal_subjects).toEqual([])
  })
})
