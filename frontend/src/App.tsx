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

const API_BASE = 'http://localhost:8000'

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

  function addActivity(status: ActivityEntry['status'], message: string) {
    setActivityLog((prev) => [...prev, { id: ++activityIdCounter, status, message }])
  }

  const handleEvent = useCallback((type: SSEEventType, data: Record<string, unknown>) => {
    console.log('[SSE]', type, data)
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
    if (type === 'outline_ready') setAwaitingReview(true)
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
      case 'searching':
        addActivity('running', `搜索中：${data.title as string}`)
        setChapterStatus((prev) => ({ ...prev, [data.title as string]: 'searching' }))
        break
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
        break
    }

  }, [navigate])

  useJobStream(job?.jobId ?? null, handleEvent)

  async function handleSubmit(topic: string, intervention: InterventionConfig, style: string) {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, intervention, style }),
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

  async function handleConfirm(reply: string) {
    if (!job) return
    setAwaitingReview(false)
    await fetch(`${API_BASE}/jobs/${job.jobId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: reply }),
    })
  }

  async function handleCancel() {
    if (!job) return
    await fetch(`${API_BASE}/jobs/${job.jobId}/cancel`, { method: 'POST' })
  }

  const isRunning = !!job && job.stage !== 'done' && job.stage !== 'error'
  const isScrollable = isRunning || awaitingReview

  return (
    <Routes>
      <Route path="/articles/:id" element={<ArticlePage />} />
      <Route path="/" element={
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          padding: '14px 16px',
          minHeight: 0,
        }}>
          {/* Body: left + right */}
          <div className="app-body" style={{ display: 'flex', gap: '12px', alignItems: 'stretch', flex: 1, minHeight: 0 }}>

            {/* Pipeline 左侧纵向栏 */}
            {job && (
              <StagePanel
                currentStage={job.stage}
                completedChapters={completedChapters}
                totalChapters={job.outline?.length ?? 0}
                chapterStatus={chapterStatus}
                outline={job.outline ?? []}
              />
            )}

            {/* Left column */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

              {/* Hero zone — vertically centered when idle, scrollable when running */}
              <div className="hero-zone" style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: isScrollable ? 'flex-start' : 'center',
                gap: '10px',
                paddingBottom: isScrollable ? '16px' : '60px',
                paddingTop: isScrollable ? '16px' : 0,
                minHeight: 0,
                overflowY: isScrollable ? 'auto' : 'visible',
              }}>
                <InputPanel
                  onSubmit={handleSubmit}
                  disabled={isRunning}
                />

                {writingState && job?.stage === 'write' && (
                  <WritingPreview title={writingState.title} buffer={writingState.buffer} />
                )}

                {isRunning && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    style={{
                      background: 'none',
                      border: '1px solid var(--border-input)',
                      borderRadius: '5px',
                      padding: '5px 14px',
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      transition: 'color 0.15s, border-color 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--danger)'
                      e.currentTarget.style.borderColor = 'var(--danger)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--text-muted)'
                      e.currentTarget.style.borderColor = 'var(--border-input)'
                    }}
                  >
                    中断任务
                  </button>
                )}

                {awaitingReview && job?.outline && (
                  <ReviewPanel outline={job.outline} onConfirm={handleConfirm} />
                )}

                {job?.stage === 'done' && (
                  <div
                    role="status"
                    style={{
                      width: '100%',
                      maxWidth: '620px',
                      padding: '10px 14px',
                      background: 'var(--success-bg)',
                      border: '1px solid var(--success-border)',
                      borderRadius: '7px',
                      fontSize: '13px',
                      color: 'var(--success-text)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span>✓</span>
                    <span>文章已生成并保存到 <code>output/</code> 目录</span>
                  </div>
                )}

                {job?.error && (
                  <div
                    role="alert"
                    style={{
                      width: '100%',
                      maxWidth: '620px',
                      padding: '10px 14px',
                      background: job.error === '已取消' ? 'var(--input-bg)' : 'var(--danger-bg)',
                      border: `1px solid ${job.error === '已取消' ? 'var(--border)' : 'var(--danger-border)'}`,
                      borderRadius: '7px',
                      fontSize: '13px',
                      color: job.error === '已取消' ? 'var(--text-muted)' : 'var(--danger)',
                    }}
                  >
                    {job.error === '已取消' ? '任务已取消' : `错误：${job.error}`}
                  </div>
                )}
              </div>

            </div>

            {/* Right column: activity log + history */}
            <div className="activity-col" style={{ width: '280px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <ActivityPanel entries={activityLog} />
              <HistoryPanel currentJob={job} />
            </div>

          </div>
        </div>
      } />
    </Routes>
  )
}
