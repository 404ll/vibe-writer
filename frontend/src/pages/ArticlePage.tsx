import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getArticle } from '../api'
import type { ArticleDetail } from '../api'

export function ArticlePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [article, setArticle] = useState<ArticleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) return
    getArticle(id)
      .then(setArticle)
      .catch((e) => {
        if (e.message === 'Article not found') setNotFound(true)
      })
      .finally(() => setLoading(false))
  }, [id])

  function handleDownload() {
    if (!article) return
    const blob = new Blob([article.content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${article.topic}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div style={{ padding: '40px', maxWidth: '720px', margin: '0 auto' }}>
        <div className="skeleton" style={{ height: '28px', width: '60%', marginBottom: '16px' }} />
        <div className="skeleton" style={{ height: '16px', width: '100%', marginBottom: '8px' }} />
        <div className="skeleton" style={{ height: '16px', width: '90%', marginBottom: '8px' }} />
        <div className="skeleton" style={{ height: '16px', width: '80%' }} />
      </div>
    )
  }

  if (notFound || !article) {
    return (
      <div style={{ padding: '40px', maxWidth: '720px', margin: '0 auto', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>文章不存在</p>
        <button className="btn-primary" onClick={() => navigate('/')}>返回首页</button>
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 16px', maxWidth: '720px', margin: '0 auto' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '24px',
        gap: '12px',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            color: 'var(--text-muted)',
            padding: '4px 0',
          }}
        >
          ← 返回
        </button>
        <span style={{
          flex: 1,
          fontWeight: 600,
          fontSize: '16px',
          color: 'var(--text-h)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {article.topic}
        </span>
        <button className="btn-primary" onClick={handleDownload} style={{ flexShrink: 0 }}>
          ↓ 下载
        </button>
      </div>

      {/* Markdown 渲染 */}
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {article.content}
        </ReactMarkdown>
      </div>
    </div>
  )
}
