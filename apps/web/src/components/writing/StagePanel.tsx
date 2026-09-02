import type { StageStatus } from '@/types'

const STAGES: { key: StageStatus; label: string; icon: string }[] = [
  { key: 'plan',   label: '规划大纲', icon: '◎' },
  { key: 'write',  label: '创作全文', icon: '✦' },
  { key: 'review', label: '审稿',     icon: '◈' },
  { key: 'export', label: '导出文章', icon: '⬡' },
]

const STAGE_ORDER: StageStatus[] = ['plan', 'write', 'review', 'export', 'done']

interface Props {
  currentStage: StageStatus | null
  outline?: string[]
}

export function StagePanel({
  currentStage,
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
                </div>
              </div>
            </div>

            {isWrite && active && outline.length > 0 && (
              <div className="chapter-steps">
                {outline.map((title) => {
                  return (
                    <div key={title} className="chapter-step">
                      <div className="chapter-dot" />
                      <span className="chapter-title">{title}</span>
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
