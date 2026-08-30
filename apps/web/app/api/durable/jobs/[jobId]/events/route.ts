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

// 获取 after_seq 参数
function afterSeq(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('after_seq') 
  if (raw === null) return -1 // 如果没有 after_seq 参数，则返回 -1
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= -1 ? parsed : null // 如果 after_seq 参数不是整数或者小于 -1，则返回 null
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
  // 获取 after_seq 参数
  const after = afterSeq(request)
  if (after === null) return invalidRequest('after_seq must be an integer >= -1.')
  const { jobId } = await context.params 
  // 获取 jobId
  try {
    // 获取工作区持久化仓库
    const jobs = getWorkspaceDurableRepositories(authorization.scope).jobs
    if (!(await jobs.getJob(jobId))) return notFound() // 如果获取不到任务，则返回 404 未找到
    const events = await jobs.listEventsAfter(jobId, after)
    if (!events) return notFound()
    // 返回事件历史响应
    return Response.json(EventHistoryResponseSchema.parse({ events }))
  } catch {
    return serverFailure() // 如果获取不到事件，则返回 500 服务器错误
  }
}
