import {
  ReplyRequestSchema,
  StatusResponseSchema,
} from '@vibe-writer/contracts/jobs'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../../../src/server/durableDatabase'
import {
  conflict,
  durableAuthorizationFailure,
  durableUnavailable,
  forbidden,
  invalidRequest,
  notFound,
  safeJson,
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
  const reply = ReplyRequestSchema.safeParse(await safeJson(request))
  if (!reply.success) return invalidRequest()
  const { jobId } = await context.params

  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope).commands.submitOutlineReply({
      jobId,
      reply: reply.data,
    })
    if (result.status === 'not_found') return notFound()
    if (result.status === 'not_awaiting_input') return conflict('Job is not awaiting input.')
    if (result.status === 'already_terminal') return conflict('Job is already terminal.')
    return Response.json(StatusResponseSchema.parse({ status: 'ok' }))
  } catch (error) {
    return error instanceof Error && error.message.startsWith('Reply idempotency collision')
      ? conflict('A different reply was already submitted.')
      : serverFailure()
  }
}
