import 'server-only'

import { ArticleDetailSchema, type ArticleDetail } from '@vibe-writer/contracts/articles'
import { headers } from 'next/headers'
import { toArticleDetail } from './durableArticles'
import {
  durableArticleReadEnabled,
  authorizeDurableHeaders,
  getWorkspaceDurableRepositories,
} from './durableDatabase'

const apiOrigin = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8000').replace(/\/$/, '')

export async function getArticleForPage(articleId: string): Promise<ArticleDetail | null> {
  if (durableArticleReadEnabled()) {
    const authorization = await authorizeDurableHeaders(await headers())
    if (authorization.status !== 'authorized') return null
    const article = await getWorkspaceDurableRepositories(authorization.scope)
      .articles.getArticle(articleId)
    return article ? toArticleDetail(article) : null
  }
  const response = await fetch(`${apiOrigin}/articles/${encodeURIComponent(articleId)}`, {
    cache: 'no-store',
  })

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Failed to fetch article ${articleId}: ${response.status}`)
  }

  return ArticleDetailSchema.parse(await response.json())
}
