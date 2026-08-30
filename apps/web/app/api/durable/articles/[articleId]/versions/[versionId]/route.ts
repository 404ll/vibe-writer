import { ArticleVersionDetailSchema } from '@vibe-writer/contracts/articles'
import { toVersionDetail } from '@/server/articles/durableArticles'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '@/server/database/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  isUuid,
  notFound,
  serverFailure,
} from '@/server/http/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ articleId: string; versionId: string }> },
): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const { articleId, versionId: rawVersionId } = await context.params
  const versionId = Number(rawVersionId)
  if (!isUuid(articleId) || !Number.isInteger(versionId) || versionId <= 0) {
    return notFound('Version not found.')
  }
  try {
    const version = await getWorkspaceDurableRepositories(authorization.scope)
      .articles.getVersion(articleId, versionId)
    if (!version) return notFound('Version not found.')
    return Response.json(ArticleVersionDetailSchema.parse(toVersionDetail(version)))
  } catch {
    return serverFailure()
  }
}
