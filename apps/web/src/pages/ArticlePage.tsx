import { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getArticle, patchArticle, getVersions, getVersion, restoreVersion } from '../api'
import type { ArticleDetail, ArticleVersionSummary } from '../api'
import { buildMarkdownComponents, slugifyHeading } from '../components/markdownComponents'

interface TocEntry {
  title: string
  slug: string
  level: number
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
      return { title, slug: slugifyHeading(title), level }
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
  const [showHistory, setShowHistory] = useState(false)
  const [versions, setVersions] = useState<ArticleVersionSummary[]>([])
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [previewVersionId, setPreviewVersionId] = useState<number | null>(null)

  useEffect(() => {
    if (!id) return
    getArticle(id)
      .then(setArticle)
      .catch((e) => { if (e.message === 'Article not found') setNotFound(true) })
      .finally(() => setLoading(false))
  }, [id])

  const mdComponents = useMemo(() => buildMarkdownComponents(true), [])
  const mdComponentsPreview = useMemo(() => buildMarkdownComponents(false), [])

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
    } catch {
      alert('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setIsEditing(false)
    setEditContent('')
  }

  async function handleShowHistory() {
    if (!id) return
    const list = await getVersions(id)
    setVersions(list)
    setPreviewContent(null)
    setPreviewVersionId(null)
    setShowHistory(true)
  }

  async function handlePreviewVersion(versionId: number) {
    if (!id) return
    const v = await getVersion(id, versionId)
    setPreviewContent(v.content)
    setPreviewVersionId(versionId)
  }

  async function handleRestoreVersion() {
    if (!id || previewVersionId === null || !article) return
    try {
      await restoreVersion(id, previewVersionId)
      setArticle({ ...article, content: previewContent! })
      setShowHistory(false)
      setPreviewContent(null)
      setPreviewVersionId(null)
    } catch {
      alert('恢复失败，请重试')
    }
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
    <div className="article-page">

      {/* ── Toolbar ── */}
      <header className="article-toolbar">
        <button
          onClick={() => navigate('/')}
          className="ghost-button"
          style={{ fontSize: '12px', padding: '5px 10px', flexShrink: 0 }}
        >
          ← 返回
        </button>
        <div style={{ width: '1px', height: '16px', background: 'var(--border)', flexShrink: 0 }} />
        <span className="article-title">{article.topic}</span>
        <span className="article-word-count">
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
              className="ghost-button"
              style={{ flexShrink: 0, fontSize: '12px', padding: '5px 14px' }}
            >
              ✕ 取消
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleShowHistory}
              className="ghost-button"
              style={{ flexShrink: 0, fontSize: '12px', padding: '5px 14px' }}
            >
              历史
            </button>
            <button
              onClick={handleEdit}
              className="ghost-button"
              style={{ flexShrink: 0, fontSize: '12px', padding: '5px 14px' }}
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
      <div className="article-grid">

        {/* 目录 — 左侧 sticky */}
        <div style={{ position: 'relative' }}>
          {toc.length > 0 && (
            <nav
              aria-label="文章目录"
              className="toc-nav"
            >
              <p className="toc-title">目录</p>
              {toc.map((entry) => (
                <a
                  key={entry.slug}
                  href={`#${entry.slug}`}
                  className={activeSlug === entry.slug ? 'toc-link toc-link--active' : 'toc-link'}
                  style={{
                    paddingLeft: entry.level === 1 ? 0 : entry.level === 2 ? '12px' : '22px',
                  }}
                >
                  {entry.title}
                </a>
              ))}
            </nav>
          )}
        </div>

        {/* 正文 */}
        <main className="article-main">
          {isEditing ? (
            /* 编辑态：左右分栏 */
            <div className="article-editor-grid">
              {/* 左栏：预览 */}
              <div className="article-preview-pane">
                <p className="article-editor-label">预览</p>
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponentsPreview}>
                    {editContent}
                  </ReactMarkdown>
                </div>
              </div>
              {/* 右栏：编辑 */}
              <div className="article-editor-pane">
                <p className="article-editor-label">编辑 Markdown</p>
                <textarea
                  className="terminal-field article-editor-textarea"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
              </div>
            </div>
          ) : (
            /* 阅读态：原有渲染 */
            <div className="prose article-paper">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {article.content}
              </ReactMarkdown>
            </div>
          )}
        </main>

        {/* 右侧空白占位（保持居中） */}
        <div />

      </div>

      {/* 历史版本侧边栏 */}
      {showHistory && (
        <div className="version-drawer">
          {/* 侧边栏 header */}
          <div className="version-drawer-header">
            <span className="version-drawer-title">历史版本</span>
            <button
              onClick={() => setShowHistory(false)}
              className="ghost-button"
              style={{ fontSize: '14px', padding: '4px 8px' }}
            >
              ✕
            </button>
          </div>

          {/* 版本列表 */}
          <div className="version-list">
            {versions.map((v) => (
              <div
                key={v.id}
                onClick={() => handlePreviewVersion(v.id)}
                className={previewVersionId === v.id ? 'version-item version-item--active' : 'version-item'}
              >
                <div className="version-date">
                  {new Date(v.saved_at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
                <div className="version-meta">
                  {v.word_count.toLocaleString()} 字
                </div>
              </div>
            ))}
          </div>

          {/* 预览区 */}
          {previewContent !== null && (
            <div className="version-preview">
              <div className="version-preview-header">
                <span className="article-editor-label" style={{ marginBottom: 0 }}>预览</span>
                <button
                  className="btn-primary"
                  onClick={handleRestoreVersion}
                  style={{ fontSize: '12px', padding: '4px 12px' }}
                >
                  恢复此版本
                </button>
              </div>
              <div className="prose version-preview-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponentsPreview}>
                  {previewContent}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
