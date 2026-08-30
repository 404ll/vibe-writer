import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '@/server/database/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  notFound,
  serverFailure,
} from '@/server/http/durableHttp'
import { createDurableEventStream } from '@/server/jobs/durableSse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function afterSeq(request: Request): number {
  const query = new URL(request.url).searchParams.get('after_seq')
  const header = request.headers.get('last-event-id')
  const value = query ?? header
  if (value === null) return -1
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= -1 ? parsed : -1
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
  const { jobId } = await context.params
  try {
    const jobs = getWorkspaceDurableRepositories(authorization.scope).jobs
    if (!(await jobs.getJob(jobId))) return notFound()
    return new Response(
      createDurableEventStream({
        jobId,
        afterSeq: afterSeq(request),
        signal: request.signal,
        source: {
          async listEventsAfter(scopedJobId, scopedAfterSeq) {
            return (await jobs.listEventsAfter(scopedJobId, scopedAfterSeq)) ?? []
          },
        },
      }),
      {
        headers: {
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Accel-Buffering': 'no',
        },
      },
    )
  } catch {
    return serverFailure()
  }
}
