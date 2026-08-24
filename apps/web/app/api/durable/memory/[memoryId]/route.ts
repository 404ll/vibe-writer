import {
  DeleteMemoryRequestSchema,
  DeleteMemoryResponseSchema,
} from '@vibe-writer/contracts/memory/management/records'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableMemoryManagementUnavailable,
  invalidRequest,
  isUuid,
  safeJson,
} from '../../../../../src/server/durableHttp'
import { memoryManagementRepositoryFailure } from '../../../../../src/server/durableMemoryManagement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ memoryId: string }> }

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  if (!durableApiEnabled() || !durableMemoryManagementApiEnabled()) {
    return durableMemoryManagementUnavailable()
  }
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const { memoryId } = await context.params
  if (!isUuid(memoryId)) return invalidRequest()
  const body = DeleteMemoryRequestSchema.safeParse(await safeJson(request))
  if (!body.success) return invalidRequest()
  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope).memory.delete({
      memoryId,
      reasonCode: body.data.reason_code,
    })
    return Response.json(DeleteMemoryResponseSchema.parse({
      status: result.status,
      memory_id: result.tombstone.memoryId,
      reason_code: result.tombstone.reasonCode,
      deleted_at: result.tombstone.deletedAt.toISOString(),
      replayed: result.replayed,
    }), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return memoryManagementRepositoryFailure(error)
  }
}
