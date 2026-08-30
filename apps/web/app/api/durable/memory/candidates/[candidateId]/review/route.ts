import {
  ReviewMemoryCandidateRequestSchema,
  ReviewMemoryCandidateResponseSchema,
} from '@vibe-writer/contracts/memory/management/candidates'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
  getWorkspaceDurableRepositories,
} from '@/server/database/durableDatabase'
import {
  durableAuthorizationFailure,
  durableMemoryManagementUnavailable,
  invalidRequest,
  isUuid,
  safeJson,
} from '@/server/http/durableHttp'
import { memoryManagementRepositoryFailure } from '@/server/memory/durableMemoryManagement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ candidateId: string }> }

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!durableApiEnabled() || !durableMemoryManagementApiEnabled()) {
    return durableMemoryManagementUnavailable()
  }
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const { candidateId } = await context.params
  if (!isUuid(candidateId)) return invalidRequest()
  const body = ReviewMemoryCandidateRequestSchema.safeParse(await safeJson(request))
  if (!body.success) return invalidRequest()
  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope)
      .memory.reviewCandidate({
        candidateId,
        decision: body.data.decision,
        reasonCode: body.data.reason_code,
        ...(body.data.decision === 'materialize' && body.data.replace_memory_id
          ? { replaceMemoryId: body.data.replace_memory_id }
          : {}),
      })
    if (result.status === 'expired') {
      return Response.json(ReviewMemoryCandidateResponseSchema.parse({
        status: 'expired',
        candidate_id: result.candidateId,
      }), { status: 410, headers: { 'cache-control': 'no-store' } })
    }
    if (result.status === 'rejected') {
      return Response.json(ReviewMemoryCandidateResponseSchema.parse({
        status: 'rejected',
        candidate_id: result.candidate.id,
        replayed: result.replayed,
      }), { headers: { 'cache-control': 'no-store' } })
    }
    return Response.json(ReviewMemoryCandidateResponseSchema.parse({
      status: 'materialized',
      candidate_id: result.candidate.id,
      memory_id: result.memory.id,
      current_revision: result.memory.currentRevision,
      replayed: result.replayed,
    }), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return memoryManagementRepositoryFailure(error)
  }
}
