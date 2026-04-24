const API_BASE = 'http://localhost:8000'

export interface ArticleSummary {
  id: string
  job_id: string
  topic: string
  word_count: number
  created_at: string
}

export interface ArticleDetail extends ArticleSummary {
  content: string
}

export async function getArticles(): Promise<ArticleSummary[]> {
  const res = await fetch(`${API_BASE}/articles`)
  if (!res.ok) throw new Error('Failed to fetch articles')
  return res.json()
}

export async function getArticle(id: string): Promise<ArticleDetail> {
  const res = await fetch(`${API_BASE}/articles/${id}`)
  if (res.status === 404) throw new Error('Article not found')
  if (!res.ok) throw new Error('Failed to fetch article')
  return res.json()
}
