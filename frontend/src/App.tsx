import { useState, useCallback } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { ArticlePage } from './pages/ArticlePage'
import { InputPanel } from './components/InputPanel'
import { StagePanel } from './components/StagePanel'
import { ReviewPanel } from './components/ReviewPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { WritingPreview } from './components/WritingPreview'
import { useJobStream } from './hooks/useJobStream'
import { HistoryPanel } from './components/HistoryPanel'
import type { JobState, InterventionConfig, SSEEventType, ActivityEntry, ReviewResult } from './types'
import { API_BASE } from './config'

const STORAGE_KEY = 'vibe_active_job_id'

function makeEmptyJob(jobId: string): JobState {
  return { jobId, stage: 'plan', outline: null, chapters: [], error: null }
}

let activityIdCounter = 0

export default function App() {
  const navigate = useNavigate()
  // 刷新时从 localStorage 恢复 jobId，让历史事件回放重建 UI
  const [job, setJob] = useState<JobState | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? makeEmptyJob(saved) : null
  })
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [completedChapters, setCompletedChapters] = useState(0)
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([])
  const [chapterStatus, setChapterStatus] = useState<Record<string, 'forming_opinion' | 'searching' | 'writing' | 'reviewing' | 'done'>>({})
  // 滑动窗口写作预览：记录最新活跃章节和累积 token
  const [writingState, setWritingState] = useState<{ title: string; buffer: string } | null>(null)

  const MAX_ACTIVITY = 50
  function addActivity(status: ActivityEntry['status'], message: string) {
    setActivityLog((prev) => {
      const next = [...prev, { id: ++activityIdCounter, status, message }]
      return next.length > MAX_ACTIVITY ? next.slice(next.length - MAX_ACTIVITY) : next
    })
  }

  const handleEvent = useCallback((type: SSEEventType, data: Record<string, unknown>) => {
    setJob((prev) => {
      if (!prev) return prev
      switch (type) {
        case 'stage_update':
          return { ...prev, stage: data.stage as JobState['stage'] }
        case 'outline_ready':
          return { ...prev, outline: data.outline as string[] }
        case 'done':
          return { ...prev, stage: 'done' }
        case 'cancelled':
          return { ...prev, stage: 'error', error: '已取消' }
        case 'error':
          return { ...prev, stage: 'error', error: data.message as string }
        default:
          return prev
      }
    })

    // awaitingReview — 直接在外层处理，避免在 setJob updater 内赋值副作用
    // outline_ready 可能触发多次（LLM 修改后重推），每次都要展示确认面板
    if (type === 'outline_ready') setAwaitingReview(true)
    if (type === 'stage_update' && (data.stage === 'write')) setAwaitingReview(false)
    if (type === 'done' || type === 'cancelled') setAwaitingReview(false)

    // 活动日志
    switch (type) {
      case 'generating_opinions':
        addActivity('running', `生成论点：${data.title as string}`)
        setChapterStatus((prev) => ({ ...prev, [data.title as string]: 'forming_opinion' }))
        break
      case 'opinions_ready':
        addActivity('info', `论点就绪：${data.title as string}`)
        break
      case 'searching': {
        const query = data.query as string | undefined
        const idx = data.index as number | undefined
        const qLabel = query ? `「${query}」` : ''
        const idxLabel = idx ? ` (${idx}/3)` : ''
        addActivity('running', `搜索中：${data.title as string}${idxLabel} ${qLabel}`.trim())
        setChapterStatus((prev) => ({ ...prev, [data.title as string]: 'searching' }))
        break
      }
      case 'search_done': {
        const preview = data.preview as string | undefined
        const chars = data.chars as number | undefined
        const query = data.query as string | undefined
        const detail = preview
          ? ` — ${preview}`
          : chars != null
            ? `（${chars} 字）`
            : ''
        addActivity(
          'success',
          `搜索完成：${data.title as string}${query ? `「${query}」` : ''}${detail}`,
        )
        break
      }
      case 'writing_chapter': {
        const title = data.title as string
        const token = data.token as string | undefined
        if (token !== undefined) {
          setWritingState((prev) =>
            prev?.title === title
              ? { title, buffer: prev.buffer + token }
              : { title, buffer: token }
          )
          setChapterStatus((prev) => ({ ...prev, [title]: 'writing' }))
        }
        break
      }
      case 'reviewing_chapter':
        addActivity('running', `轻审中：${data.title as string}`)
        setChapterStatus((prev) => ({ ...prev, [data.title as string]: 'reviewing' }))
        setWritingState((prev) => prev?.title === (data.title as string) ? null : prev)
        break
      case 'chapter_done': {
        const review = data.review as ReviewResult | undefined
        setCompletedChapters((n) => n + 1)
        setChapterStatus((prev) => ({ ...prev, [data.title as string]: 'done' }))
        if (review && !review.passed) {
          addActivity('failed', `轻审未通过：${data.title as string} → 已重写`)
        } else {
          addActivity('success', `章节完成：${data.title as string}`)
        }
        break
      }
      case 'reviewing_full':
        addActivity('running', '全文重审中...')
        break
      case 'review_done': {
        const results = data.results as Array<{ title: string; passed: boolean; feedback: string }>
        const failedCount = results.filter((r) => !r.passed).length
        if (failedCount === 0) {
          addActivity('success', '全文审稿通过')
        } else {
          addActivity('info', `全文审稿：${failedCount} 章重写完成`)
        }
        break
      }
      case 'done':
        addActivity('success', '文章已生成')
        setWritingState(null)
        localStorage.removeItem(STORAGE_KEY)
        if (data.article_id) {
          setTimeout(() => navigate(`/articles/${data.article_id}`), 800)
        }
        break
      case 'cancelled':
        addActivity('info', '任务已取消')
        setWritingState(null)
        localStorage.removeItem(STORAGE_KEY)
        break
      case 'error':
        addActivity('failed', `错误：${data.message as string}`)
        setWritingState(null)
        localStorage.removeItem(STORAGE_KEY)
        break
    }

  }, [navigate])

  useJobStream(job?.jobId ?? null, handleEvent)

  async function handleSubmit(topic: string, intervention: InterventionConfig, style: string, targetWords: number | null) {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, intervention, style, target_words: targetWords }),
    })
    const { job_id } = await res.json()
    localStorage.setItem(STORAGE_KEY, job_id)
    setJob(makeEmptyJob(job_id))
    setCompletedChapters(0)
    setAwaitingReview(false)
    setActivityLog([])
    setWritingState(null)
    setChapterStatus({})
  }

  async function handleConfirm(reply: string, outline: string[]) {
    if (!job) return
    setAwaitingReview(false)
    await fetch(`${API_BASE}/jobs/${job.jobId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: reply, outline }),
    })
  }

  function resetJobUi() {
    localStorage.removeItem(STORAGE_KEY)
    setJob(null)
    setAwaitingReview(false)
    setCompletedChapters(0)
    setActivityLog([])
    setWritingState(null)
    setChapterStatus({})
  }

  async function handleCancel() {
    if (!job) return
    const jobId = job.jobId
    try {
      await fetch(`${API_BASE}/jobs/${jobId}/cancel`, { method: 'POST' })
    } catch {
      // 即使请求失败也清空前端，避免卡在旧 job
    }
    resetJobUi()
  }

  const isRunning = !!job && job.stage !== 'done' && job.stage !== 'error'
  const isScrollable = isRunning || awaitingReview

  return (
    <Routes>
      <Route path="/articles/:id" element={<ArticlePage />} />
      <Route path="/" element={
        <div className="app-shell">
          <header className="top-nav">
            <div className="nav-logo" aria-hidden="true">
              <div className="nav-logo-inner">
                <span className="pixel-icon pixel-icon--computer" />
              </div>
            </div>
            <nav className="nav-links" aria-label="主导航">
              <span className="nav-link">写作</span>
              <span className="nav-link">历史</span>
            </nav>
            <span className="nav-cta">BOOT_STATION</span>
          </header>

          <div className={isScrollable ? 'app-body app-body--running' : 'app-body app-body--idle'}>
            <div className={isScrollable ? 'work-column work-column--active' : 'work-column work-column--idle'}>
              <div className={isScrollable ? 'hero-zone hero-zone--active' : 'hero-zone hero-zone--idle'}>
                <div className={isScrollable ? 'workspace-layout' : 'workspace-layout workspace-layout--idle'}>
                  {isScrollable && job && (
                    <StagePanel
                      currentStage={job.stage}
                      completedChapters={completedChapters}
                      totalChapters={job.outline?.length ?? 0}
                      chapterStatus={chapterStatus}
                      outline={job.outline ?? []}
                    />
                  )}

                  <InputPanel
                    onSubmit={handleSubmit}
                    disabled={isRunning}
                  />
                </div>

                {writingState && job?.stage === 'write' && (
                  <WritingPreview title={writingState.title} buffer={writingState.buffer} />
                )}

                {isRunning && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="ghost-button danger-button task-cancel-button"
                  >
                    中断任务
                  </button>
                )}

                {awaitingReview && job?.outline && (
                  <ReviewPanel
                    key={job.outline.join('|')}
                    outline={job.outline}
                    onConfirm={handleConfirm}
                  />
                )}

                {job?.stage === 'done' && (
                  <div
                    role="status"
                    className="terminal-status terminal-status--success"
                  >
                    <span>✓</span>
                    <span>文章已生成并保存到 <code>output/</code> 目录</span>
                  </div>
                )}

                {job?.error && (
                  <div
                    role="alert"
                    className={job.error === '已取消' ? 'terminal-status terminal-status--muted' : 'terminal-status terminal-status--danger'}
                  >
                    {job.error === '已取消' ? '任务已取消' : `错误：${job.error}`}
                  </div>
                )}
              </div>

            </div>

            {isScrollable && (
              <div className="activity-col activity-col--active">
                <ActivityPanel entries={activityLog} />
              </div>
            )}
          </div>

          {!isScrollable && (
            <section className="recent-section">
              <HistoryPanel currentJob={job} />
            </section>
          )}

          <footer className="site-footer">
            <div className="footer-icons" aria-hidden="true">
              <span className="footer-icon" />
              <span className="footer-icon" />
              <span className="footer-icon" />
            </div>
            <span>© VIBE-WRITER / VER: 80.S.WAVE</span>
          </footer>
        </div>
      } />
    </Routes>
  )
}
