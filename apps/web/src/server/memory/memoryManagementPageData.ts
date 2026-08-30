import 'server-only'

import {
  MemoryManagementBootstrapResponseSchema,
  type MemoryManagementBootstrapResponse,
} from '@vibe-writer/contracts/memory-policy'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
  durableMemorySignalApiEnabled,
  getMemoryConsentPolicy,
  getWorkspaceDurableRepositories,
} from '@/server/database/durableDatabase'
import { encodeDurableUuidCursor } from '@/server/http/durableCursor'
import { createMemoryPolicyAccess } from './durableMemoryAccess'
import { toActiveMemory, toMemoryCandidate } from './durableMemoryManagement'
import { toMemorySignal } from './durableMemorySignals'

export type MemoryManagementPageDataResult =
  | { status: 'ready'; data: MemoryManagementBootstrapResponse }
  | {
      status:
        | 'disabled'
        | 'configuration_invalid'
        | 'auth_unconfigured'
        | 'unauthenticated'
        | 'forbidden'
        | 'dependency_unavailable'
    }

export async function loadMemoryManagementPageData(
  headers: Pick<Headers, 'get'>,
): Promise<MemoryManagementPageDataResult> {
  if (!durableApiEnabled() || !durableMemoryManagementApiEnabled()) {
    return { status: 'disabled' }
  }
  const policy = getMemoryConsentPolicy()
  if (!policy) return { status: 'configuration_invalid' }
  const authorization = await authorizeDurableHeaders(headers)
  if (authorization.status !== 'authorized') return authorization

  const signalsEnabled = durableMemorySignalApiEnabled()
  const access = createMemoryPolicyAccess({
    policy,
    scope: authorization.scope,
    managementEnabled: true,
    signalsEnabled,
  })
  const repositories = getWorkspaceDurableRepositories(authorization.scope)
  try {
    const activePromise = repositories.memory.listPage({ limit: 50 })
    const signalsPromise = signalsEnabled
      ? repositories.memorySourceSignals.listOwnPage({ limit: 50 })
      : Promise.resolve({ items: [], nextCursor: null })
    const candidatesPromise = access.workspace.capabilities.review_candidates
      ? repositories.memory.listCandidatesPage({ limit: 50 })
      : Promise.resolve({ items: [], nextCursor: null })
    const [active, signals, candidates] = await Promise.all([
      activePromise,
      signalsPromise,
      candidatesPromise,
    ])

    return {
      status: 'ready',
      data: MemoryManagementBootstrapResponseSchema.parse({
        ...access,
        active: {
          memories: active.items.map(toActiveMemory),
          next_cursor: active.nextCursor
            ? encodeDurableUuidCursor(active.nextCursor)
            : null,
        },
        signals: {
          signals: signals.items.map(toMemorySignal),
          next_cursor: signals.nextCursor
            ? encodeDurableUuidCursor(signals.nextCursor)
            : null,
        },
        candidates: {
          candidates: candidates.items.map(toMemoryCandidate),
          next_cursor: candidates.nextCursor
            ? encodeDurableUuidCursor(candidates.nextCursor)
            : null,
        },
      }),
    }
  } catch {
    return { status: 'dependency_unavailable' }
  }
}
