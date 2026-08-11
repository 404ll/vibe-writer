import {
  DeleteMemorySignalRequestSchema,
  DeleteMemorySignalResponseSchema,
} from '@vibe-writer/contracts/memory-signals'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemorySignalApiEnabled,
  getMemoryConsentPolicyVersion,
  getWorkspaceDurableRepositories,
} from '../../../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableMemorySignalConfigurationUnavailable,
  durableMemorySignalUnavailable,
  invalidRequest,
  isUuid,
  safeJson,
} from '../../../../../../src/server/durableHttp'
import { memorySignalRepositoryFailure } from '../../../../../../src/server/durableMemorySignals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ signalId: string }> }

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  if (!durableApiEnabled() || !durableMemorySignalApiEnabled()) {
    return durableMemorySignalUnavailable()
  }
  if (!getMemoryConsentPolicyVersion()) {
    return durableMemorySignalConfigurationUnavailable()
  }
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const { signalId } = await context.params
  if (!isUuid(signalId)) return invalidRequest()
  const body = DeleteMemorySignalRequestSchema.safeParse(await safeJson(request))
  if (!body.success) return invalidRequest()

  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope)
      .memorySourceSignals.delete({
        sourceSignalId: signalId,
        reasonCode: body.data.reason_code,
      })
    return Response.json(DeleteMemorySignalResponseSchema.parse({
      status: result.status,
      source_signal_id: result.tombstone.sourceSignalId,
      reason_code: result.tombstone.reasonCode,
      deleted_at: result.tombstone.deletedAt.toISOString(),
      replayed: result.replayed,
    }), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return memorySignalRepositoryFailure(error)
  }
}
