'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { patchArticle, getVersions, getVersion, restoreVersion } from '../api'
import type { ArticleDetail, ArticleVersionSummary } from '../api'
import { MarkdownContent } from './markdownComponents'
import { slugifyHeading } from './markdownUtils'
import { HOME_ROUTE } from '../routes'

interface TocEntry {
  title: string
  slug: string
  level: number
}

/**
 * 从原始 Markdown 中提取一到三级标题生成目录。
 * 标题锚点复用正文渲染的 slugifyHeading，保证目录 href 与实际 heading id 一致。
 */
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

export function ArticlePage({
  articleId,
  initialArticle,
}: {
  articleId: string
  initialArticle: ArticleDetail | null
}) {
  const router = useRouter()
  const [article, setArticle] = useState<ArticleDetail | null>(initialArticle)
  const [activeSlug, setActiveSlug] = useState('')
  // 编辑态使用独立草稿；只有保存成功后才更新当前文章。
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [versions, setVersions] = useState<ArticleVersionSummary[]>([])
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [previewVersionId, setPreviewVersionId] = useState<number | null>(null)

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
    // 复制当前正文，取消编辑时即可直接丢弃草稿而不污染阅读态。
    setEditContent(article.content)
    setIsEditing(true)
  }

  async function handleSave() {
    if (!article) return
    setSaving(true)
    try {
      const updated = await patchArticle(articleId, editContent, article.revision)
      setArticle(updated ?? {
        ...article,
        content: editContent,
        word_count: editContent.replaceAll(' ', '').length,
        ...(article.revision !== undefined ? { revision: article.revision + 1 } : {}),
      })
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
    const list = await getVersions(articleId)
    setVersions(list)
    setPreviewContent(null)
    setPreviewVersionId(null)
    setShowHistory(true)
  }

  async function handlePreviewVersion(versionId: number) {
    const v = await getVersion(articleId, versionId)
    setPreviewContent(v.content)
    setPreviewVersionId(versionId)
  }

  async function handleRestoreVersion() {
    if (previewVersionId === null || !article) return
    try {
      const updated = await restoreVersion(articleId, previewVersionId, article.revision)
      setArticle(updated ?? {
        ...article,
        content: previewContent!,
        word_count: previewContent!.replaceAll(' ', '').length,
        ...(article.revision !== undefined ? { revision: article.revision + 1 } : {}),
      })
      setShowHistory(false)
      setPreviewContent(null)
      setPreviewVersionId(null)
    } catch {
      alert('恢复失败，请重试')
    }
  }

  if (!article) {
    return (
      <div style={{ padding: '80px 24px', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontSize: '15px' }}>文章不存在</p>
        <button className="btn-primary" onClick={() => router.push(HOME_ROUTE)}>← 返回首页</button>
      </div>
    )
  }

  const toc = extractToc(article.content)

  return (
    <div className="article-page">

      {/* ── Toolbar ── */}
      <header className="article-toolbar">
        <button
          onClick={() => router.push(HOME_ROUTE)}
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
        {/* 编辑态按钮组 */}
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
                  {/* MarkdownContent 统一解析 GFM，并接管 Mermaid 代码块。 */}
                  <MarkdownContent>{editContent}</MarkdownContent>
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
              {/* 阅读态生成标题 id，使目录链接和滚动观察指向同一批 heading。 */}
              <MarkdownContent withHeadingIds>{article.content}</MarkdownContent>
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
                {/* 历史版本复用同一渲染链路，但不生成正文目录锚点。 */}
                <MarkdownContent>{previewContent}</MarkdownContent>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
