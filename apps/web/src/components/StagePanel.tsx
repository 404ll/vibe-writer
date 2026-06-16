import type { StageStatus } from '../types'

const STAGES: { key: StageStatus; label: string; icon: string }[] = [
  { key: 'plan',   label: '规划大纲', icon: '◎' },
  { key: 'write',  label: '撰写章节', icon: '✦' },
  { key: 'review', label: '审稿',     icon: '◈' },
  { key: 'export', label: '导出文章', icon: '⬡' },
]

const STAGE_ORDER: StageStatus[] = ['plan', 'write', 'review', 'export', 'done']

const CH_STATUS_LABEL: Record<string, string> = {
  forming_opinion: '论点中',
  searching:       '搜索中',
  writing:         '写作中',
  reviewing:       '审稿中',
  done:            '✓',
}

interface Props {
  currentStage: StageStatus | null
  completedChapters: number
  totalChapters: number
  chapterStatus?: Record<string, 'forming_opinion' | 'searching' | 'writing' | 'reviewing' | 'done'>
  outline?: string[]
}

export function StagePanel({
  currentStage,
  completedChapters,
  totalChapters,
  chapterStatus = {},
  outline = [],
}: Props) {
  const currentIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="写作进度"
      className="card stage-panel"
    >
      <div className="card-label">写作进度</div>

      {STAGES.map(({ key, label, icon }, i) => {
        const stageIdx = STAGE_ORDER.indexOf(key)
        const done = currentIndex > stageIdx || currentStage === 'done'
        const active = STAGE_ORDER[currentIndex] === key
        const isWrite = key === 'write'
        const nodeClass = [
          'stage-node',
          active ? 'stage-node--active' : '',
          done ? 'stage-node--done' : '',
        ].filter(Boolean).join(' ')
        const iconClass = [
          'stage-icon',
          active ? 'stage-icon--active' : '',
          done ? 'stage-icon--done' : '',
        ].filter(Boolean).join(' ')
        const labelClass = [
          'stage-label',
          active ? 'stage-label--active' : '',
          done ? 'stage-label--done' : '',
        ].filter(Boolean).join(' ')

        return (
          <div key={key}>
            <div aria-current={active ? 'step' : undefined} className={nodeClass}>
              <div className={iconClass}>{done ? '✓' : icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={labelClass}>
                  {label}
                  {isWrite && totalChapters > 0 && (
                    <span style={{ opacity: 0.72, marginLeft: '3px' }}>
                      {completedChapters}/{totalChapters}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {isWrite && active && outline.length > 0 && (
              <div className="chapter-steps">
                {outline.map((title) => {
                  const status = chapterStatus[title]
                  const isDone = status === 'done'
                  const isActive = !!status && !isDone
                  const stepClass = isActive ? 'chapter-step chapter-step--active' : 'chapter-step'
                  const dotClass = [
                    'chapter-dot',
                    isActive ? 'chapter-dot--active' : '',
                    isDone ? 'chapter-dot--done' : '',
                  ].filter(Boolean).join(' ')
                  const titleClass = [
                    'chapter-title',
                    isActive ? 'chapter-title--active' : '',
                    isDone ? 'chapter-title--done' : '',
                  ].filter(Boolean).join(' ')

                  return (
                    <div key={title} className={stepClass}>
                      <div className={dotClass} />
                      <span className={titleClass}>{title}</span>
                      {status && (
                        <span className="chapter-status">
                          {CH_STATUS_LABEL[status] ?? status}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {i < STAGES.length - 1 && (
              <div className={done ? 'stage-line stage-line--done' : 'stage-line'} />
            )}
          </div>
        )
      })}
    </div>
  )
}
