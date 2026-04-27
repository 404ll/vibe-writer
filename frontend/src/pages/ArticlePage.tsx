import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getArticle, patchArticle } from '../api'
import type { ArticleDetail } from '../api'

interface TocEntry {
  title: string
  slug: string
  level: number
}

function slugify(text: string) {
  return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
}

function extractToc(markdown: string): TocEntry[] {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => {
      const match = line.match(/^(#{1,3}) (.+)/)
      if (!match) return null
      const level = match[1].length
      const title = match[2].trim()
      return { title, slug: slugify(title), level }
    })
    .filter(Boolean) as TocEntry[]
}

export function ArticlePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [article, setArticle] = useState<ArticleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [activeSlug, setActiveSlug] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id) return
    getArticle(id)
      .then(setArticle)
      .catch((e) => { if (e.message === 'Article not found') setNotFound(true) })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    if (!article) return
    const headings = document.querySelectorAll('.prose h1, .prose h2, .prose h3')
    if (!headings.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) { setActiveSlug(entry.target.id); break }
        }
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 }
    )
    headings.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [article])

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

  function handleEdit() {
    if (!article) return
    setEditContent(article.content)
    setIsEditing(true)
  }

  async function handleSave() {
    if (!article || !id) return
    setSaving(true)
    try {
      await patchArticle(id, editContent)
      setArticle({ ...article, content: editContent })
      setIsEditing(false)
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setIsEditing(false)
    setEditContent('')
  }

  if (loading) {
    return (
      <div style={{ maxWidth: '680px', margin: '80px auto', padding: '0 24px' }}>
        {[60, 100, 85, 90, 75].map((w, i) => (
          <div key={i} className="skeleton" style={{ height: i === 0 ? '32px' : '15px', width: `${w}%`, marginBottom: i === 0 ? '32px' : '10px', borderRadius: '4px' }} />
        ))}
      </div>
    )
  }

  if (notFound || !article) {
    return (
      <div style={{ padding: '80px 24px', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '15px' }}>文章不存在</p>
        <button className="btn-primary" onClick={() => navigate('/')}>← 返回首页</button>
      </div>
    )
  }

  const toc = extractToc(article.content)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>

      {/* ── Toolbar ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'rgba(240,236,227,0.92)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 32px',
        height: '52px',
        display: 'flex', alignItems: 'center', gap: '20px',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '13px', color: 'var(--text-muted)', padding: '4px 0',
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px',
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-h)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          ← 返回
        </button>
        <div style={{ width: '1px', height: '16px', background: 'var(--border)', flexShrink: 0 }} />
        <span style={{
          flex: 1, fontFamily: 'var(--hand)', fontSize: '17px',
          color: 'var(--text-h)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {article.topic}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>
          {article.word_count?.toLocaleString()} 字
        </span>
        {isEditing ? (
          <>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving}
              style={{ flexShrink: 0, fontSize: '12px', padding: '5px 14px' }}
            >
              {saving ? '保存中…' : '✓ 保存'}
            </button>
            <button
              onClick={handleCancel}
              style={{
                flexShrink: 0, fontSize: '12px', padding: '5px 14px',
                background: 'none', border: '1px solid var(--border)',
                borderRadius: '4px', cursor: 'pointer', color: 'var(--text-muted)',
              }}
            >
              ✕ 取消
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleEdit}
              style={{
                flexShrink: 0, fontSize: '12px', padding: '5px 14px',
                background: 'none', border: '1px solid var(--border)',
                borderRadius: '4px', cursor: 'pointer', color: 'var(--text)',
              }}
            >
              ✎ 编辑
            </button>
            <button
              className="btn-primary"
              onClick={handleDownload}
              style={{ flexShrink: 0, fontSize: '12px', padding: '5px 14px' }}
            >
              ↓ 下载
            </button>
          </>
        )}
      </header>

      {/* ── 主体 ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: toc.length > 0 ? '1fr min(680px, 100%) 1fr' : '1fr min(680px, 100%) 1fr',
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '0 24px',
        boxSizing: 'border-box',
        gap: '0 32px',
      }}>

        {/* 目录 — 左侧 sticky */}
        <div style={{ position: 'relative' }}>
          {toc.length > 0 && (
            <nav
              aria-label="文章目录"
              style={{
                position: 'sticky',
                top: '68px',
                maxHeight: 'calc(100vh - 84px)',
                overflowY: 'auto',
                paddingTop: '40px',
                paddingRight: '8px',
              }}
            >
              <p style={{
                fontSize: '10px', fontWeight: 600, letterSpacing: '1.5px',
                textTransform: 'uppercase', color: 'var(--text-label)',
                marginBottom: '10px',
              }}>目录</p>
              {toc.map((entry) => (
                <a
                  key={entry.slug}
                  href={`#${entry.slug}`}
                  style={{
                    display: 'block',
                    paddingLeft: entry.level === 1 ? 0 : entry.level === 2 ? '12px' : '22px',
                    paddingTop: '4px',
                    paddingBottom: '4px',
                    fontSize: '12.5px',
                    lineHeight: '1.5',
                    color: activeSlug === entry.slug ? 'var(--accent)' : 'var(--text-muted)',
                    textDecoration: 'none',
                    fontWeight: activeSlug === entry.slug ? 500 : 400,
                    borderLeft: activeSlug === entry.slug ? '2px solid var(--accent)' : '2px solid transparent',
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => { if (activeSlug !== entry.slug) (e.currentTarget as HTMLElement).style.color = 'var(--text)' }}
                  onMouseLeave={(e) => { if (activeSlug !== entry.slug) (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)' }}
                >
                  {entry.title}
                </a>
              ))}
            </nav>
          )}
        </div>

        {/* 正文 */}
        <main style={{ padding: '48px 0 100px', minWidth: 0 }}>
          {isEditing ? (
            /* 编辑态：左右分栏 */
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', height: 'calc(100vh - 120px)' }}>
              {/* 左栏：预览 */}
              <div style={{
                overflowY: 'auto',
                paddingRight: '16px',
                borderRight: '1px solid var(--border)',
              }}>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase' }}>预览</p>
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {editContent}
                  </ReactMarkdown>
                </div>
              </div>
              {/* 右栏：编辑 */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <p style={{ fontSize: '11px', color: 'var(--accent)', marginBottom: '16px', fontWeight: 600, letterSpacing: '1px', textTransform: 'uppercase' }}>编辑 Markdown</p>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  style={{
                    flex: 1,
                    border: '1.5px solid var(--accent)',
                    borderRadius: '6px',
                    padding: '16px',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    lineHeight: '1.7',
                    color: 'var(--text)',
                    background: 'var(--bg)',
                    resize: 'none',
                    outline: 'none',
                  }}
                />
              </div>
            </div>
          ) : (
            /* 阅读态：原有渲染 */
            <div className="prose">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => <h1 id={slugify(String(children))}>{children}</h1>,
                  h2: ({ children }) => <h2 id={slugify(String(children))}>{children}</h2>,
                  h3: ({ children }) => <h3 id={slugify(String(children))}>{children}</h3>,
                }}
              >
                {article.content}
              </ReactMarkdown>
            </div>
          )}
        </main>

        {/* 右侧空白占位（保持居中） */}
        <div />

      </div>
    </div>
  )
}
