import {
  ArticleMutationResponseSchema,
  ArticleRestoreRequestSchema,
} from '@vibe-writer/contracts/articles'
import { toArticleDetail } from '@/server/articles/durableArticles'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '@/server/database/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  forbidden,
  invalidRequest,
  isUuid,
  notFound,
  revisionConflict,
  safeJson,
  serverFailure,
} from '@/server/http/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ articleId: string; versionId: string }> },
): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  if (authorization.scope.role === 'viewer') return forbidden()
  const body = ArticleRestoreRequestSchema.safeParse(await safeJson(request))
  if (!body.success) return invalidRequest()
  const { articleId, versionId: rawVersionId } = await context.params
  const versionId = Number(rawVersionId)
  if (!isUuid(articleId) || !Number.isInteger(versionId) || versionId <= 0) {
    return notFound('Version not found.')
  }

  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope)
      .articles.restoreVersion({
      articleId,
      versionId,
      expectedRevision: body.data.expected_revision,
      })
    if (result.status === 'not_found') return notFound('Article not found.')
    if (result.status === 'version_not_found') return notFound('Version not found.')
    if (result.status === 'revision_conflict') {
      return revisionConflict(result.currentRevision)
    }
    return Response.json(
      ArticleMutationResponseSchema.parse({
        status: 'ok',
        article: toArticleDetail(result.article),
      }),
    )
  } catch {
    return serverFailure()
  }
}
