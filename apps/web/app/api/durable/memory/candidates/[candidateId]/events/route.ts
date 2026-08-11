import { ListMemoryCandidateEventsResponseSchema } from '@vibe-writer/contracts/memory-management'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableMemoryManagementUnavailable,
  invalidRequest,
  isUuid,
} from '../../../../../../../src/server/durableHttp'
import {
  memoryManagementRepositoryFailure,
  toMemoryCandidateEvent,
} from '../../../../../../../src/server/durableMemoryManagement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ candidateId: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  if (!durableApiEnabled() || !durableMemoryManagementApiEnabled()) {
    return durableMemoryManagementUnavailable()
  }
  const authorization = await authorizeDurableHeaders(_request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const { candidateId } = await context.params
  if (!isUuid(candidateId)) return invalidRequest()
  try {
    const rows = await getWorkspaceDurableRepositories(authorization.scope)
      .memory.listCandidateEvents(candidateId)
    return Response.json(ListMemoryCandidateEventsResponseSchema.parse({
      candidate_id: candidateId,
      events: rows.map(toMemoryCandidateEvent),
    }), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return memoryManagementRepositoryFailure(error)
  }
}
