import 'server-only'

import {
  MemoryPolicyAccessResponseSchema,
  type MemoryConsentPolicyDocument,
  type MemoryPolicyAccessResponse,
} from '@vibe-writer/contracts/memory-policy'
import type { AuthorizedWorkspaceScope } from '@vibe-writer/db'

export function createMemoryPolicyAccess(input: {
  policy: MemoryConsentPolicyDocument
  scope: AuthorizedWorkspaceScope
  managementEnabled: boolean
  signalsEnabled: boolean
}): MemoryPolicyAccessResponse {
  const canEdit = input.scope.role === 'editor' || input.scope.role === 'owner'
  const canOwn = input.scope.role === 'owner'
  return MemoryPolicyAccessResponseSchema.parse({
    policy: input.policy,
    workspace: {
      role: input.scope.role,
      capabilities: {
        read_active_memories: input.managementEnabled,
        review_candidates: input.managementEnabled && canEdit,
        delete_active_memories: input.managementEnabled && canOwn,
        manage_own_signals: input.signalsEnabled,
        create_shared_signals: input.signalsEnabled && canEdit,
      },
      signal_subjects: input.signalsEnabled
        ? [
            {
              subject: { kind: 'principal', key: input.scope.principalId },
              label: '仅自己',
            },
            ...(canEdit
              ? [{
                  subject: { kind: 'workspace' as const, key: 'default' },
                  label: '当前工作区',
                }]
              : []),
          ]
        : [],
    },
  })
}
