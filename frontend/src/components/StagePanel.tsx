import type { StageStatus } from '../types'

const STAGES: { key: StageStatus; label: string }[] = [
  { key: 'plan',   label: '规划大纲' },
  { key: 'write',  label: '撰写章节' },
  { key: 'review', label: '审稿' },
  { key: 'export', label: '导出文章' },
]

const STAGE_ORDER: StageStatus[] = ['plan', 'write', 'review', 'export', 'done']

interface Props {
  currentStage: StageStatus | null
  completedChapters: number
  totalChapters: number
}

export function StagePanel({ currentStage, completedChapters, totalChapters }: Props) {
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
                  boxShadow: active ? '0 0 0 3px rgba(92,74,50,0.16)' : undefined,
                  transition: 'background 0.2s, box-shadow 0.2s',
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
