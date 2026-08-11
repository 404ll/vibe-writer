import { randomUUID } from 'node:crypto'
import {
  CreateJobRequestSchema,
  CreateJobResponseSchema,
} from '@vibe-writer/contracts/jobs'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  forbidden,
  invalidRequest,
  safeJson,
  serverFailure,
} from '../../../../src/server/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  if (authorization.scope.role === 'viewer') return forbidden()
  const parsed = CreateJobRequestSchema.safeParse(await safeJson(request))
  if (!parsed.success) return invalidRequest()

  try {
    const idempotencyKey =
      request.headers.get('idempotency-key')?.trim() || randomUUID()
    // 接口请求只负责把“用户确实提交过任务”持久化。`createJob` 会在同一事务
    // 写入任务与事务发件箱；这里不直接调用 BullMQ，避免数据库成功但队列发布失败。
    const { job } = await getWorkspaceDurableRepositories(authorization.scope).jobs.createJob({
      ...parsed.data,
      idempotencyKey,
    })
    return Response.json(CreateJobResponseSchema.parse({ job_id: job.id }))
  } catch {
    return serverFailure()
  }
}
