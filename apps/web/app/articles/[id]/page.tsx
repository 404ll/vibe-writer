import { ArticlePage } from '@/components/articles/ArticlePage'
import { getArticleForPage } from '@/server/articles/articleQueries'

export default async function ArticleRoute({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const article = await getArticleForPage(id)
  return <ArticlePage articleId={id} initialArticle={article} />
}
