import type { StageStatus } from '../types'

const STAGES: { key: StageStatus; label: string }[] = [
  { key: 'plan', label: '规划大纲' },
  { key: 'write', label: '撰写章节' },
  { key: 'export', label: '导出文章' },
]

const STAGE_ORDER: StageStatus[] = ['plan', 'write', 'export', 'done']

interface Props {
  currentStage: StageStatus | null
  completedChapters: number
  totalChapters: number
}

export function StagePanel({ currentStage, completedChapters, totalChapters }: Props) {
  const currentIndex = currentStage ? STAGE_ORDER.indexOf(currentStage) : -1

  return (
    <div style={{ display: 'flex', gap: '1rem', padding: '1rem', background: '#f9f9f9' }}>
      {STAGES.map(({ key, label }, i) => {
        const done = currentIndex > i || currentStage === 'done'
        const active = STAGE_ORDER[currentIndex] === key
        return (
          <div
            key={key}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '4px',
              background: done ? '#4caf50' : active ? '#2196f3' : '#ddd',
              color: done || active ? '#fff' : '#333',
            }}
          >
            {done ? '✓ ' : ''}{label}
            {key === 'write' && totalChapters > 0 && (
              <span style={{ fontSize: '0.8em', marginLeft: '0.3rem' }}>
                ({completedChapters}/{totalChapters})
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
