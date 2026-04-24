import { useState, useCallback } from 'react'
import { InputPanel } from './components/InputPanel'
import { StagePanel } from './components/StagePanel'
import { ReviewPanel } from './components/ReviewPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { useJobStream } from './hooks/useJobStream'
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
      case 'error':
        addActivity('failed', `错误：${data.message as string}`)
        break
    }

    if (reviewUpdate !== null) setAwaitingReview(reviewUpdate)
  }, [])

  useJobStream(job?.jobId ?? null, handleEvent)

  async function handleSubmit(topic: string, intervention: InterventionConfig) {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, intervention }),
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

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '32px 16px', fontFamily: 'var(--sans)' }}>
      <h1 style={{ fontFamily: 'var(--mono)', fontSize: '22px', fontWeight: 700, color: '#0f172a', marginBottom: '24px', letterSpacing: '-0.5px' }}>
        vibe-writer
      </h1>

      <InputPanel
        onSubmit={handleSubmit}
        disabled={!!job && job.stage !== 'done' && job.stage !== 'error'}
      />

      {job && (
        <StagePanel
          currentStage={job.stage}
          completedChapters={completedChapters}
          totalChapters={job.outline?.length ?? 0}
        />
      )}

      {awaitingReview && job?.outline && (
        <ReviewPanel outline={job.outline} onConfirm={handleConfirm} />
      )}

      <ActivityPanel entries={activityLog} />

      {job?.stage === 'done' && (
        <div
          role="status"
          style={{ padding: '12px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', fontSize: '14px', color: '#15803d' }}
        >
          ✓ 文章已生成并保存到 <code style={{ background: '#dcfce7', padding: '1px 5px', borderRadius: '3px' }}>output/</code> 目录
        </div>
      )}

      {job?.error && (
        <div
          role="alert"
          style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '14px', color: '#dc2626' }}
        >
          错误：{job.error}
        </div>
      )}
    </div>
  )
}
