import { useState, useCallback } from 'react'
import { Routes, Route } from 'react-router-dom'
import { ArticlePage } from './pages/ArticlePage'
import { InputPanel } from './components/InputPanel'
import { StagePanel } from './components/StagePanel'
import { ReviewPanel } from './components/ReviewPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { useJobStream } from './hooks/useJobStream'
import { HistoryPanel } from './components/HistoryPanel'
import type { JobState, InterventionConfig, SSEEventType, ActivityEntry, ReviewResult } from './types'

const API_BASE = 'http://localhost:8000'

const INITIAL_JOB: JobState = {
  jobId: '',
  stage: 'plan',
  outline: null,
  chapters: [],
  error: null,
}

let activityIdCounter = 0

export default function App() {
  const [job, setJob] = useState<JobState | null>(null)
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [completedChapters, setCompletedChapters] = useState(0)
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([])

  function addActivity(status: ActivityEntry['status'], message: string) {
    setActivityLog((prev) => [...prev, { id: ++activityIdCounter, status, message }])
  }

  const handleEvent = useCallback((type: SSEEventType, data: Record<string, unknown>) => {
    let reviewUpdate: boolean | null = null

    setJob((prev) => {
      if (!prev) return prev
      switch (type) {
        case 'stage_update':
          return { ...prev, stage: data.stage as JobState['stage'] }
        case 'outline_ready':
          reviewUpdate = true
          return { ...prev, outline: data.outline as string[] }
        case 'done':
          reviewUpdate = false
          return { ...prev, stage: 'done' }
        case 'cancelled':
          reviewUpdate = false
          return { ...prev, stage: 'error', error: '已取消' }
        case 'error':
          return { ...prev, stage: 'error', error: data.message as string }
        default:
          return prev
      }
    })

    // 活动日志
    switch (type) {
      case 'searching':
        addActivity('running', `搜索中：${data.title as string}`)
        break
      case 'reviewing_chapter':
        addActivity('running', `轻审中：${data.title as string}`)
        break
      case 'chapter_done': {
        const review = data.review as ReviewResult | undefined
        setCompletedChapters((n) => n + 1)
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
        addActivity('success', '文章已生成，保存到 output/ 目录')
        break
      case 'cancelled':
        addActivity('info', '任务已取消')
        break
      case 'error':
        addActivity('failed', `错误：${data.message as string}`)
        break
    }

    if (reviewUpdate !== null) setAwaitingReview(reviewUpdate)
  }, [])

  useJobStream(job?.jobId ?? null, handleEvent)

  async function handleSubmit(topic: string, intervention: InterventionConfig, style: string) {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, intervention, style }),
    })
    const { job_id } = await res.json()
    setJob({ ...INITIAL_JOB, jobId: job_id })
    setCompletedChapters(0)
    setAwaitingReview(false)
    setActivityLog([])
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
          <div style={{ display: 'flex', gap: '12px', alignItems: 'stretch', flex: 1, minHeight: 0 }}>

            {/* Left column */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

              {/* Hero zone — vertically centered when idle */}
              <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                paddingBottom: isRunning ? 0 : '60px',
                minHeight: 0,
              }}>
                <InputPanel
                  onSubmit={handleSubmit}
                  disabled={isRunning}
                />

                {job && (
                  <StagePanel
                    currentStage={job.stage}
                    completedChapters={completedChapters}
                    totalChapters={job.outline?.length ?? 0}
                  />
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

              {/* History strip — bottom */}
              <HistoryPanel currentJob={job} />
            </div>

            {/* Right column: activity log */}
            <div style={{ width: '280px', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
              <ActivityPanel entries={activityLog} />
            </div>

          </div>
        </div>
      } />
    </Routes>
  )
}
