import { useState, useCallback } from 'react'
import { InputPanel } from './components/InputPanel'
import { StagePanel } from './components/StagePanel'
import { ReviewPanel } from './components/ReviewPanel'
import { useJobStream } from './hooks/useJobStream'
import type { JobState, InterventionConfig, SSEEventType } from './types'

const API_BASE = 'http://localhost:8000'

const INITIAL_STATE: JobState = {
  jobId: '',
  stage: 'plan',
  outline: null,
  chapters: [],
  error: null,
}

export default function App() {
  const [job, setJob] = useState<JobState | null>(null)
  const [awaitingReview, setAwaitingReview] = useState(false)
  const [completedChapters, setCompletedChapters] = useState(0)

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
        case 'chapter_done':
          setCompletedChapters((n) => n + 1)
          return prev
        case 'done':
          reviewUpdate = false
          return { ...prev, stage: 'done' }
        case 'error':
          return { ...prev, stage: 'error', error: data.message as string }
        default:
          return prev
      }
    })

    if (reviewUpdate !== null) {
      setAwaitingReview(reviewUpdate)
    }
  }, [])

  useJobStream(job?.jobId ?? null, handleEvent)

  async function handleSubmit(topic: string, intervention: InterventionConfig) {
    const res = await fetch(`${API_BASE}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, intervention }),
    })
    const { job_id } = await res.json()
    setJob({ ...INITIAL_STATE, jobId: job_id })
    setCompletedChapters(0)
    setAwaitingReview(false)
  }

  async function handleConfirm(reply: string) {
    if (!job) return
    await fetch(`${API_BASE}/jobs/${job.jobId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: reply }),
    })
    setAwaitingReview(false)
  }

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <h1>vibe-writer</h1>

      <InputPanel onSubmit={handleSubmit} disabled={!!job && job.stage !== 'done' && job.stage !== 'error'} />

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

      {job?.stage === 'done' && (
        <div style={{ padding: '1rem', background: '#e8f5e9', borderRadius: '4px', margin: '1rem' }}>
          ✓ 文章已生成并保存到 <code>output/</code> 目录
        </div>
      )}

      {job?.error && (
        <div style={{ padding: '1rem', background: '#ffebee', borderRadius: '4px', margin: '1rem' }}>
          错误：{job.error}
        </div>
      )}
    </div>
  )
}
