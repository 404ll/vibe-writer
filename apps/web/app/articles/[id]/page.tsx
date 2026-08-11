import { ArticlePage } from '../../../src/components/ArticlePage'
import { getArticleForPage } from '../../../src/server/articleQueries'

export default async function ArticleRoute({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const article = await getArticleForPage(id)
  return <ArticlePage articleId={id} initialArticle={article} />
}
