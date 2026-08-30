import { EventHistoryResponseSchema } from '@vibe-writer/contracts/jobs/events'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '@/server/database/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  invalidRequest,
  notFound,
  serverFailure,
} from '@/server/http/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function afterSeq(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('after_seq')
  if (raw === null) return -1
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= -1 ? parsed : null
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const after = afterSeq(request)
  if (after === null) return invalidRequest('after_seq must be an integer >= -1.')
  const { jobId } = await context.params

  try {
    const jobs = getWorkspaceDurableRepositories(authorization.scope).jobs
    if (!(await jobs.getJob(jobId))) return notFound()
    const events = await jobs.listEventsAfter(jobId, after)
    if (!events) return notFound()
    return Response.json(EventHistoryResponseSchema.parse({ events }))
  } catch {
    return serverFailure()
  }
}
