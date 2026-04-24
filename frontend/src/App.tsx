import { useState, useCallback } from 'react'
import { InputPanel } from './components/InputPanel'
import { StagePanel } from './components/StagePanel'
import { ReviewPanel } from './components/ReviewPanel'
import { useJobStream } from './hooks/useJobStream'
import type { JobState, InterventionConfig, SSEEventType } from './types'

const API_BASE = 'http://localhost:8000'

// 新建 Job 时的初始状态模板
const INITIAL_STATE: JobState = {
  jobId: '',
  stage: 'plan',
  outline: null,
  chapters: [],
  error: null,
}

/**
 * 根组件，持有整个应用的状态机。
 *
 * 状态流转：
 *   null（未开始）
 *   → plan（规划大纲中）
 *   → [awaitingReview=true]（等待用户确认大纲）
 *   → write（逐章写作中）
 *   → export（导出 Markdown）
 *   → done / error
 */
export default function App() {
  const [job, setJob] = useState<JobState | null>(null)
  const [awaitingReview, setAwaitingReview] = useState(false)   // 是否正在等待用户确认大纲
  const [completedChapters, setCompletedChapters] = useState(0) // 已完成章节数，用于进度显示

  /**
   * SSE 事件处理器。
   * useCallback 确保函数引用稳定，避免 useJobStream 内部 useEffect 反复重建。
   *
   * 注意：setAwaitingReview 不能直接放在 setJob 的 updater 函数里，
   * 因为 updater 应该是纯函数（无副作用）。
   * 这里用 reviewUpdate 局部变量"暂存"意图，updater 执行完后再统一 apply。
   */
  const handleEvent = useCallback((type: SSEEventType, data: Record<string, unknown>) => {
    let reviewUpdate: boolean | null = null

    setJob((prev) => {
      if (!prev) return prev
      switch (type) {
        case 'stage_update':
          return { ...prev, stage: data.stage as JobState['stage'] }
        case 'outline_ready':
          reviewUpdate = true   // 大纲就绪，稍后打开 ReviewPanel
          return { ...prev, outline: data.outline as string[] }
        case 'chapter_done':
          setCompletedChapters((n) => n + 1)
          return prev
        case 'done':
          reviewUpdate = false  // 任务完成，关闭 ReviewPanel（如果还开着）
          return { ...prev, stage: 'done' }
        case 'error':
          return { ...prev, stage: 'error', error: data.message as string }
        default:
          return prev
      }
    })

    // updater 执行完后，统一更新 awaitingReview
    if (reviewUpdate !== null) {
      setAwaitingReview(reviewUpdate)
    }
  }, [])

  // 订阅当前 Job 的 SSE 流；job 为 null 或 jobId 为空时不建立连接
  useJobStream(job?.jobId ?? null, handleEvent)

  /** 提交主题，创建 Job，重置所有状态 */
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

  /** 用户在 ReviewPanel 确认（或修改）大纲后，发送回复唤醒后端 Orchestrator */
  async function handleConfirm(reply: string) {
    if (!job) return
    await fetch(`${API_BASE}/jobs/${job.jobId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: reply }),
    })
    // fetch 成功后才关闭 ReviewPanel，避免请求失败时 UI 状态不一致
    setAwaitingReview(false)
  }

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <h1>vibe-writer</h1>

      {/* 输入面板：Job 运行中时禁用，避免重复提交 */}
      <InputPanel onSubmit={handleSubmit} disabled={!!job && job.stage !== 'done' && job.stage !== 'error'} />

      {/* 阶段进度条：Job 创建后才显示 */}
      {job && (
        <StagePanel
          currentStage={job.stage}
          completedChapters={completedChapters}
          totalChapters={job.outline?.length ?? 0}
        />
      )}

      {/* 大纲确认面板：收到 outline_ready 事件后显示 */}
      {awaitingReview && job?.outline && (
        <ReviewPanel outline={job.outline} onConfirm={handleConfirm} />
      )}

      {/* 完成提示 */}
      {job?.stage === 'done' && (
        <div style={{ padding: '1rem', background: '#e8f5e9', borderRadius: '4px', margin: '1rem' }}>
          ✓ 文章已生成并保存到 <code>output/</code> 目录
        </div>
      )}

      {/* 错误提示 */}
      {job?.error && (
        <div style={{ padding: '1rem', background: '#ffebee', borderRadius: '4px', margin: '1rem' }}>
          错误：{job.error}
        </div>
      )}
    </div>
  )
}
