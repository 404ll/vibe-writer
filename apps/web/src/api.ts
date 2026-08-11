import { API_BASE } from './config'
import type {
  ArticleDetail,
  ArticleSummary,
  ArticleVersionDetail,
  ArticleVersionSummary,
} from '@vibe-writer/contracts/articles'
import { ArticleMutationResponseSchema } from '@vibe-writer/contracts/articles'

export type {
  ArticleDetail,
  ArticleSummary,
  ArticleVersionDetail,
  ArticleVersionSummary,
} from '@vibe-writer/contracts/articles'

/** 获取所有文章的摘要列表 */
export async function getArticles(): Promise<ArticleSummary[]> {
  const res = await fetch(`${API_BASE}/articles`)
  if (!res.ok) throw new Error('Failed to fetch articles')
  return res.json()
}

/** 更新保存指定文章的内容 */
export async function patchArticle(
  id: string,
  content: string,
  expectedRevision?: number,
): Promise<ArticleDetail | null> {
  const res = await fetch(`${API_BASE}/articles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, expected_revision: expectedRevision }),
  })
  if (!res.ok) throw new Error('Failed to save article')
  const result = ArticleMutationResponseSchema.parse(await res.json())
  return result.article ?? null
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
export async function restoreVersion(
  articleId: string,
  versionId: number,
  expectedRevision?: number,
): Promise<ArticleDetail | null> {
  const res = await fetch(`${API_BASE}/articles/${articleId}/versions/${versionId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision }),
  })
  if (!res.ok) throw new Error('Failed to restore version')
  const result = ArticleMutationResponseSchema.parse(await res.json())
  return result.article ?? null
}
