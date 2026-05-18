import { API_BASE } from './config'

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

export interface ArticleVersionSummary {
  id: number
  saved_at: string
  word_count: number
}

export interface ArticleVersionDetail {
  id: number
  content: string
  saved_at: string
}

/** 获取所有文章的摘要列表 */
export async function getArticles(): Promise<ArticleSummary[]> {
  const res = await fetch(`${API_BASE}/articles`)
  if (!res.ok) throw new Error('Failed to fetch articles')
  return res.json()
}

/** 获取指定文章的详细内容 */
export async function getArticle(id: string): Promise<ArticleDetail> {
  const res = await fetch(`${API_BASE}/articles/${id}`)
  if (res.status === 404) throw new Error('Article not found')
  if (!res.ok) throw new Error('Failed to fetch article')
  return res.json()
}

/** 更新保存指定文章的内容 */
export async function patchArticle(id: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/articles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error('Failed to save article')
}

/** 获取指定文章的所有历史版本记录摘要 */
export async function getVersions(id: string): Promise<ArticleVersionSummary[]> {
  const res = await fetch(`${API_BASE}/articles/${id}/versions`)
  if (!res.ok) throw new Error('Failed to fetch versions')
  const data = await res.json()
  return data.versions
}

/** 获取指定文章某个历史版本的详细内容 */
export async function getVersion(articleId: string, versionId: number): Promise<ArticleVersionDetail> {
  const res = await fetch(`${API_BASE}/articles/${articleId}/versions/${versionId}`)
  if (!res.ok) throw new Error('Failed to fetch version')
  return res.json()
}

/** 将指定文章回滚恢复到某个历史版本 */
export async function restoreVersion(articleId: string, versionId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/articles/${articleId}/versions/${versionId}/restore`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error('Failed to restore version')
}
