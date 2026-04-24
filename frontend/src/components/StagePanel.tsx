import type { StageStatus } from '../types'

const STAGES: { key: StageStatus; label: string }[] = [
  { key: 'plan',   label: '规划大纲' },
  { key: 'write',  label: '撰写章节' },
  { key: 'review', label: '审稿' },
  { key: 'export', label: '导出文章' },
]

const STAGE_ORDER: StageStatus[] = ['plan', 'write', 'review', 'export', 'done']

const CHAPTER_STATUS_LABEL: Record<string, string> = {
  searching:  '搜索中',
  writing:    '写作中',
  reviewing:  '审稿中',
  done:       '完成',
}

const CHAPTER_STATUS_COLOR: Record<string, string> = {
  searching:  'var(--accent)',
  writing:    'var(--accent)',
  reviewing:  'var(--accent)',
  done:       'var(--accent-done)',
}

interface Props {
  currentStage: StageStatus | null
  completedChapters: number
  totalChapters: number
  chapterStatus?: Record<string, 'searching' | 'writing' | 'reviewing' | 'done'>
  outline?: string[]
}

export function StagePanel({ currentStage, completedChapters, totalChapters, chapterStatus = {}, outline = [] }: Props) {
  const currentIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="写作进度"
      className="card"
      style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '12px 16px', flexShrink: 0 }}
    >
      <div className="card-label" style={{ margin: 0, position: 'absolute', clip: 'rect(0,0,0,0)', width: 1, height: 1, overflow: 'hidden' }}>写作进度</div>
      {STAGES.map(({ key, label }, i) => {
        const done   = currentIndex > i || currentStage === 'done'
        const active = STAGE_ORDER[currentIndex] === key

        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', flex: i < STAGES.length - 1 ? 1 : undefined }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div
                aria-current={active ? 'step' : undefined}
                style={{
                  width: '24px', height: '24px',
                  borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', fontWeight: 600,
                  background: done ? 'var(--accent-done)' : active ? 'var(--accent)' : 'var(--stage-idle-bg)',
                  color: done || active ? 'var(--text-on-accent)' : 'var(--text-muted)',
                  border: active ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'background 0.3s, box-shadow 0.3s',
                  animationName: active ? 'pulse-ring' : 'none',
                  animationDuration: '2s',
                  animationTimingFunction: 'ease-in-out',
                  animationIterationCount: 'infinite',
                }}
              >
                {done ? '✓' : i + 1}
              </div>
              <span style={{
                fontSize: '11px',
                fontWeight: active ? 600 : 400,
                color: done ? 'var(--accent-done)' : active ? 'var(--accent)' : 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}>
                {label}
                {key === 'write' && totalChapters > 0 && (
                  <span style={{ marginLeft: '3px', opacity: 0.8 }}>
                    ({completedChapters}/{totalChapters})
                  </span>
                )}
              </span>
              {key === 'write' && totalChapters > 0 && (
                <div style={{ width: '48px', height: '3px', background: 'var(--stage-idle-bg)', borderRadius: '2px', overflow: 'hidden', marginTop: '3px' }}>
                  <div style={{
                    height: '100%',
                    width: `${(completedChapters / totalChapters) * 100}%`,
                    background: done ? 'var(--accent-done)' : 'var(--accent)',
                    borderRadius: '2px',
                    transition: 'width 0.4s ease',
                  }} />
                </div>
              )}
              {key === 'write' && active && outline.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '120px' }}>
                  {outline.map((title) => {
                    const status = chapterStatus[title]
                    return (
                      <div key={title} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px' }}>
                        <span style={{
                          width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                          background: status ? CHAPTER_STATUS_COLOR[status] : 'var(--stage-idle-bg)',
                          transition: 'background 0.3s',
                        }} />
                        <span style={{
                          color: status ? (status === 'done' ? 'var(--accent-done)' : 'var(--accent)') : 'var(--text-muted)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px',
                        }}>
                          {title}
                        </span>
                        {status && status !== 'done' && (
                          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                            {CHAPTER_STATUS_LABEL[status]}
                          </span>
                        )}
                        {status === 'done' && <span style={{ color: 'var(--accent-done)', flexShrink: 0 }}>✓</span>}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            {i < STAGES.length - 1 && (
              <div style={{
                flex: 1, height: '1.5px',
                background: done ? 'var(--accent-done)' : 'var(--border)',
                margin: '0 4px', marginBottom: '18px',
                transition: 'background 0.3s',
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}
