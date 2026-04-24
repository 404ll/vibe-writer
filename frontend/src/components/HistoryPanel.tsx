import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { JobState } from '../types'
import { getArticles } from '../api'
import type { ArticleSummary } from '../api'

interface Props {
  currentJob: JobState | null
}

function formatGroupLabel(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const articleDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today.getTime() - articleDay.getTime()) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function groupByDate(articles: ArticleSummary[]): { label: string; items: ArticleSummary[] }[] {
  const groups: Map<string, ArticleSummary[]> = new Map()
  for (const a of articles) {
    const label = formatGroupLabel(a.created_at)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(a)
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }))
}

export function HistoryPanel({ currentJob }: Props) {
  const navigate = useNavigate()
  const [articles, setArticles] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(true)

  async function fetchArticles() {
    try {
      const data = await getArticles()
      setArticles(data)
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }

  // 初始加载
  useEffect(() => {
    fetchArticles()
  }, [])

  // job 完成后重新拉取
  useEffect(() => {
    if (currentJob?.stage === 'done') {
      fetchArticles()
    }
  }, [currentJob?.stage])

  return (
    <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: '14px 16px' }}>
      <div className="card-label">历史文章</div>

      {loading ? (
        <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: '36px', borderRadius: '5px' }} />
          ))}
        </div>
      ) : articles.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 0' }}>暂无文章</p>
      ) : (
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {groupByDate(articles).map(({ label, items }) => (
            <div key={label}>
              <div style={{
                fontSize: '9px', fontWeight: 600, letterSpacing: '0.5px',
                textTransform: 'uppercase', color: 'var(--text-label)',
                padding: '8px 2px 4px',
              }}>
                {label}
              </div>
              {items.map((a) => (
                <div
                  key={a.id}
                  onClick={() => navigate(`/articles/${a.id}`)}
                  style={{
                    padding: '6px 8px',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    marginBottom: '2px',
                    border: '1px solid transparent',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--input-bg)'
                    e.currentTarget.style.borderColor = 'var(--border)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.borderColor = 'transparent'
                  }}
                >
                  <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-h)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '2px' }}>
                    {a.topic}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    {a.word_count} 字
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
