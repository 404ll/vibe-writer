import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { JobState } from '@/types'
import { getArticles } from '@/api/articles'
import type { ArticleSummary } from '@/api/articles'
import { articleRoute } from '@/lib/routes'

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
  const router = useRouter()
  const [articles, setArticles] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(true)
  const completedJobId = currentJob?.stage === 'done' ? currentJob.jobId : null

  useEffect(() => {
    let cancelled = false

    getArticles()
      .then((data) => {
        if (!cancelled) setArticles(data)
      })
      .catch(() => {
        // 历史记录不阻塞工作台。
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [completedJobId])

  return (
    <div className="card history-panel">
      <div className="card-label">历史文章</div>

      {loading ? (
        <div className="history-loading">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: '36px', borderRadius: '5px' }} />
          ))}
        </div>
      ) : articles.length === 0 ? (
        <p className="history-empty">暂无文章</p>
      ) : (
        <div className="history-scroll">
          {groupByDate(articles).map(({ label, items }) => (
            <div key={label}>
              <div className="history-group">{label}</div>
              {items.map((a) => (
                <div
                  key={a.id}
                  className="history-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(articleRoute(a.id))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') router.push(articleRoute(a.id))
                  }}
                >
                  <div className="history-title">{a.topic}</div>
                  <div className="history-meta">{a.word_count} 字</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
