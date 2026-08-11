import { ArticleListResponseSchema } from '@vibe-writer/contracts/articles'
import { toArticleSummary } from '../../../../src/server/durableArticles'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  serverFailure,
} from '../../../../src/server/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  try {
    const rows = await getWorkspaceDurableRepositories(authorization.scope)
      .articles.listArticles()
    return Response.json(ArticleListResponseSchema.parse(rows.map(toArticleSummary)))
  } catch {
    return serverFailure()
  }
}
