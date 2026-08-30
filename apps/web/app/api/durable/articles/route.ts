import { ArticleListResponseSchema } from '@vibe-writer/contracts/articles'
import { toArticleSummary } from '@/server/articles/durableArticles'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '@/server/database/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  serverFailure,
} from '@/server/http/durableHttp'

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
