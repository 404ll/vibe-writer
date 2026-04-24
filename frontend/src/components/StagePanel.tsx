import type { StageStatus } from '../types'

const STAGES: { key: StageStatus; label: string }[] = [
  { key: 'plan', label: '规划大纲' },
  { key: 'write', label: '撰写章节' },
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
      style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '14px 20px' }}
    >
      {STAGES.map(({ key, label }, i) => {
        const done = currentIndex > i || currentStage === 'done'
        const active = STAGE_ORDER[currentIndex] === key

        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', flex: i < STAGES.length - 1 ? 1 : undefined }}>
            {/* 节点 */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div
                aria-current={active ? 'step' : undefined}
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: 600,
                  background: done ? '#16a34a' : active ? '#2563eb' : '#f1f5f9',
                  color: done || active ? '#fff' : '#94a3b8',
                  border: active ? '2px solid #2563eb' : '2px solid transparent',
                  boxShadow: active ? '0 0 0 3px rgba(37,99,235,0.15)' : undefined,
                  transition: 'all 0.2s',
                }}
              >
                {done ? '✓' : i + 1}
              </div>
              <span style={{
                fontSize: '11px',
                fontWeight: active ? 600 : 400,
                color: done ? '#16a34a' : active ? '#2563eb' : '#94a3b8',
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
            {/* 连接线 */}
            {i < STAGES.length - 1 && (
              <div style={{
                flex: 1,
                height: '2px',
                background: done ? '#16a34a' : '#e2e8f0',
                margin: '0 4px',
                marginBottom: '18px',
                transition: 'background 0.3s',
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}
