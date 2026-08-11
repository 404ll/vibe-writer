import { StatusResponseSchema } from '@vibe-writer/contracts/jobs'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  forbidden,
  notFound,
  serverFailure,
} from '../../../../../../src/server/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  if (authorization.scope.role === 'viewer') return forbidden()
  const { jobId } = await context.params
  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope)
      .jobs.requestCancellation(jobId)
    if (result === 'not_found') return notFound()
    return Response.json(StatusResponseSchema.parse({ status: 'ok' }))
  } catch {
    return serverFailure()
  }
}
