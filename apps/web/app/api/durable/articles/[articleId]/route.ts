import {
  ArticleDetailSchema,
  ArticleMutationResponseSchema,
  ArticlePatchRequestSchema,
} from '@vibe-writer/contracts/articles'
import { toArticleDetail } from '../../../../../src/server/durableArticles'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableUnavailable,
  forbidden,
  invalidRequest,
  isUuid,
  notFound,
  preconditionRequired,
  revisionConflict,
  safeJson,
  serverFailure,
} from '../../../../../src/server/durableHttp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ articleId: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const { articleId } = await context.params
  if (!isUuid(articleId)) return notFound('Article not found.')
  try {
    const article = await getWorkspaceDurableRepositories(authorization.scope)
      .articles.getArticle(articleId)
    if (!article) return notFound('Article not found.')
    return Response.json(ArticleDetailSchema.parse(toArticleDetail(article)))
  } catch {
    return serverFailure()
  }
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  if (!durableApiEnabled()) return durableUnavailable()
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  if (authorization.scope.role === 'viewer') return forbidden()
  const rawBody = await safeJson(request)
  if (
    typeof rawBody === 'object' && rawBody !== null &&
    !Object.hasOwn(rawBody, 'expected_revision')
  ) return preconditionRequired()
  const body = ArticlePatchRequestSchema.safeParse(rawBody)
  if (!body.success) return invalidRequest()
  const { articleId } = await context.params
  if (!isUuid(articleId)) return notFound('Article not found.')

  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope)
      .articles.patchArticle({
      articleId,
      content: body.data.content,
      expectedRevision: body.data.expected_revision,
      })
    if (result.status === 'not_found') return notFound('Article not found.')
    if (result.status === 'revision_conflict') {
      return revisionConflict(result.currentRevision)
    }
    if (result.status !== 'updated') return serverFailure()
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
