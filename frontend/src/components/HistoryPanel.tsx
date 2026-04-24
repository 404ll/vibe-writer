import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { JobState } from '../types'
import { getArticles } from '../api'
import type { ArticleSummary } from '../api'

interface Props {
  currentJob: JobState | null
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
    <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
          {articles.map((a) => (
            <div
              key={a.id}
              onClick={() => navigate(`/articles/${a.id}`)}
              style={{
                padding: '8px 10px',
                borderRadius: '5px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '13px',
                color: 'var(--text)',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--input-bg)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span style={{ color: 'var(--accent)', fontSize: '8px', flexShrink: 0 }}>●</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.topic}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px', flexShrink: 0 }}>
                {a.word_count} 字
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
