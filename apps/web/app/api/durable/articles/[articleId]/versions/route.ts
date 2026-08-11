import { ArticleVersionsResponseSchema } from '@vibe-writer/contracts/articles'
import { toVersionSummary } from '../../../../../../src/server/durableArticles'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  isUuid,
  notFound,
  serverFailure,
} from '../../../../../../src/server/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ articleId: string }> },
): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const { articleId } = await context.params
  if (!isUuid(articleId)) return notFound('Article not found.')
  try {
    const versions = await getWorkspaceDurableRepositories(authorization.scope)
      .articles.listVersions(articleId)
    if (!versions) return notFound('Article not found.')
    return Response.json(
      ArticleVersionsResponseSchema.parse({ versions: versions.map(toVersionSummary) }),
    )
  } catch {
    return serverFailure()
  }
}
