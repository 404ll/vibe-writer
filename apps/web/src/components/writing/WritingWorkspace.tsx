'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { InputPanel } from './InputPanel'
import { StagePanel } from './StagePanel'
import { ReviewPanel } from './ReviewPanel'
import { ActivityPanel } from './ActivityPanel'
import { WritingPreview } from './WritingPreview'
import { HistoryPanel } from './HistoryPanel'
import { useJobStream } from '@/hooks/useJobStream'
import { useActiveJobId, clearActiveJobId, writeActiveJobId } from '@/lib/storage/jobStorage'
import { articleRoute } from '@/lib/routes'
import type { JobState, InterventionConfig, SSEEventType, ActivityEntry, ReviewResult } from '@/types'
import { API_BASE } from '@/lib/config'
import { createJob } from '@/lib/api/jobs'

function makeEmptyJob(jobId: string): JobState {
  return { jobId, stage: 'plan', outline: null, chapters: [], error: null }
}

let activityIdCounter = 0

export function WritingWorkspace({ memoryManagementEnabled = false }: {
  memoryManagementEnabled?: boolean
}) {
  const router = useRouter()
  // 只持久化版本化的 jobId；任务事实和事件历史仍由后端负责。
  const persistedJobId = useActiveJobId()
  const [jobState, setJob] = useState<JobState | null>(null)
  const job = jobState ?? (persistedJobId ? makeEmptyJob(persistedJobId) : null)
  // 这些状态只服务当前页面展示；后端仍是任务进度和文章内容的事实来源
  const [awaitingReview, setAwaitingReview] = useState(false)
  // 全文审核可能让同一章节进入重写并再次发出 chapter_done；用标题集合去重，
  // 避免断线重放或重写轮次把“已完成章节数”累加到大纲总数以上。
  const [completedChapterTitles, setCompletedChapterTitles] = useState<Set<string>>(
    () => new Set(),
  )
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([])
  const [chapterStatus, setChapterStatus] = useState<Record<string, 'forming_opinion' | 'searching' | 'extracting' | 'writing' | 'reviewing' | 'done'>>({})
  // 滑动窗口写作预览：记录最新活跃章节和累积 token
  const [writingState, setWritingState] = useState<{ title: string; buffer: string } | null>(null)

  const MAX_ACTIVITY = 50
  function addActivity(status: ActivityEntry['status'], message: string) {
    setActivityLog((prev) => {
      const next = [...prev, { id: ++activityIdCounter, status, message }]
      // 日志只保留最近一段，避免长任务持续推送事件后撑大前端状态
      return next.length > MAX_ACTIVITY ? next.slice(next.length - MAX_ACTIVITY) : next
    })
  }

  // SSE 事件入口：先更新核心 job 状态，再同步各个辅助 UI 面板
  const handleEvent = useCallback((type: SSEEventType, data: Record<string, unknown>) => {
    setJob((prev) => {
      const current = prev ?? (persistedJobId ? makeEmptyJob(persistedJobId) : null)
      if (!current) return current
      switch (type) {
        case 'stage_update':
          return { ...current, stage: data.stage as JobState['stage'] }
        case 'outline_ready':
          return { ...current, outline: data.outline as string[] }
        case 'done':
          return { ...current, stage: 'done' }
        case 'cancelled':
          return { ...current, stage: 'error', error: '已取消' }
        case 'error':
          return { ...current, stage: 'error', error: data.message as string }
        default:
          return current
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
      case 'extracting': {
        const title = data.title as string
        const url = data.url as string
        addActivity('running', `正在读取网页：${title}「${url}」`)
        setChapterStatus((prev) => ({ ...prev, [title]: 'extracting' }))
        break
      }
      case 'extract_done': {
        const title = data.title as string
        const sourceTitle = data.source_title as string | undefined
        const chars = data.chars as number
        const status = data.status as 'ready' | 'failed' | 'unavailable'
        addActivity(
          status === 'ready' ? 'success' : 'info',
          status === 'ready'
            ? `网页读取完成：${sourceTitle ?? title}（${chars} 字）`
            : `网页读取未完成：${title}，将换来源或基于已有资料继续`,
        )
        break
      }
      case 'writing_chapter': {
        const title = data.title as string
        const token = data.token as string | undefined
        if (token !== undefined) {
          // 后端推送正文增量块（当前是一章一个完整块）；这里统一累积成预览文本。
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
        const title = data.title as string
        setCompletedChapterTitles((prev) => new Set(prev).add(title))
        setChapterStatus((prev) => ({ ...prev, [title]: 'done' }))
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
        clearActiveJobId()
        if (data.article_id) {
          // 稍等日志状态渲染完成，再跳转到生成后的文章详情页
          setTimeout(() => router.push(articleRoute(String(data.article_id))), 800)
        }
        break
      case 'cancelled':
        addActivity('info', '任务已取消')
        setWritingState(null)
        clearActiveJobId()
        break
      case 'error':
        addActivity('failed', `错误：${data.message as string}`)
        setWritingState(null)
        clearActiveJobId()
        break
    }

  }, [persistedJobId, router])

  useJobStream(job?.jobId ?? null, handleEvent)

  // 创建任务走共享 client：同一提交复用 Idempotency-Key，避免重试再开一份 Job。
  async function handleSubmit(topic: string, intervention: InterventionConfig, style: string, targetWords: number | null) {
    const { job_id } = await createJob({
      topic,
      intervention,
      style,
      target_words: targetWords,
    })
    writeActiveJobId(job_id)
    setJob(makeEmptyJob(job_id))
    setCompletedChapterTitles(new Set())
    setAwaitingReview(false)
    setActivityLog([])
    setWritingState(null)
    setChapterStatus({})
  }

  // 用户确认或调整大纲后，把最终大纲交回后端继续写作阶段
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
    clearActiveJobId()
    setJob(null)
    setAwaitingReview(false)
    setCompletedChapterTitles(new Set())
    setActivityLog([])
    setWritingState(null)
    setChapterStatus({})
  }

  // 取消失败时也清理本地 UI，后续刷新不会继续挂在旧 job 上
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
  // 顶部像素状态灯由 job 阶段和人工审稿等待态共同推导
  const navPetState = job?.stage === 'error'
    ? 'error'
    : job?.stage === 'done'
      ? 'done'
      : awaitingReview
        ? 'review'
        : isRunning
          ? job?.stage ?? 'run'
          : 'idle'
  const navPetLabel: Record<string, string> = {
    idle: '空闲',
    plan: '规划中',
    write: '写作中',
    review: '审稿中',
    export: '保存中',
    done: '完成',
    error: '异常',
    run: '运行中',
  }
  const navPetCode: Record<string, string> = {
    idle: 'IDLE',
    plan: 'PLAN',
    write: 'WRITE',
    review: 'CHECK',
    export: 'SAVE',
    done: 'DONE',
    error: 'ERR',
    run: 'RUN',
  }

  return (
    <div className="app-shell">
          <header className="top-nav">
            <div className="nav-logo" aria-hidden="true">
              <div className="nav-logo-inner">
                <span className="pixel-icon pixel-icon--computer" />
              </div>
            </div>
            {memoryManagementEnabled ? (
              <Link href="/memory" className="ghost-button nav-memory-link">
                Memory
              </Link>
            ) : null}
            <div className={`nav-pet nav-pet--${navPetState}`} role="status" aria-label={`状态：${navPetLabel[navPetState] ?? '运行中'}`}>
              <span className="nav-pet-frame" aria-hidden="true">
                <span className="pet-sprite" />
                <span className="pet-signal">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="pet-code">{navPetCode[navPetState] ?? 'RUN'}</span>
              </span>
            </div>
          </header>

          <div className={isScrollable ? 'app-body app-body--running' : 'app-body app-body--idle'}>
            <div className={isScrollable ? 'work-column work-column--active' : 'work-column work-column--idle'}>
              <div className={isScrollable ? 'hero-zone hero-zone--active' : 'hero-zone hero-zone--idle'}>
                <div className={isScrollable ? 'workspace-layout' : 'workspace-layout workspace-layout--idle'}>
                  {isScrollable && job && (
                    <StagePanel
                      currentStage={job.stage}
                      completedChapters={completedChapterTitles.size}
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
  )
}
