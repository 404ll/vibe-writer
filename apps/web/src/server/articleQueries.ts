import 'server-only'

import type { ArticleDetail } from '@vibe-writer/contracts/articles'
import { headers } from 'next/headers'
import { toArticleDetail } from './durableArticles'
import { authorizeDurableHeaders, getWorkspaceDurableRepositories } from './durableDatabase'

export async function getArticleForPage(articleId: string): Promise<ArticleDetail | null> {
  const authorization = await authorizeDurableHeaders(await headers())
  if (authorization.status !== 'authorized') return null
  const article = await getWorkspaceDurableRepositories(authorization.scope)
    .articles.getArticle(articleId)
  return article ? toArticleDetail(article) : null
}
