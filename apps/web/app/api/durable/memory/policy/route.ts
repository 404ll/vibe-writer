import { MemoryPolicyAccessResponseSchema } from '@vibe-writer/contracts/memory-policy'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
  durableMemorySignalApiEnabled,
  getMemoryConsentPolicy,
} from '@/server/database/durableDatabase'
import {
  durableAuthorizationFailure,
  durableMemoryPolicyConfigurationUnavailable,
  durableMemoryPolicyUnavailable,
} from '@/server/http/durableHttp'
import { createMemoryPolicyAccess } from '@/server/memory/durableMemoryAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const managementEnabled = durableMemoryManagementApiEnabled()
  const signalsEnabled = durableMemorySignalApiEnabled()
  if (!durableApiEnabled() || (!managementEnabled && !signalsEnabled)) {
    return durableMemoryPolicyUnavailable()
  }
  const policy = getMemoryConsentPolicy()
  if (!policy) return durableMemoryPolicyConfigurationUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  return Response.json(
    MemoryPolicyAccessResponseSchema.parse(createMemoryPolicyAccess({
      policy,
      scope: authorization.scope,
      managementEnabled,
      signalsEnabled,
    })),
    { headers: { 'cache-control': 'no-store' } },
  )
}
