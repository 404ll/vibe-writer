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
      style={{
        width: '140px',
        flexShrink: 0,
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        boxShadow: 'var(--shadow)',
        padding: '14px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        alignSelf: 'flex-start',
        position: 'sticky',
        top: '14px',
      }}
    >
      <div className="card-label" style={{ marginBottom: '12px' }}>写作进度</div>

      {STAGES.map(({ key, label, icon }, i) => {
        const stageIdx = STAGE_ORDER.indexOf(key)
        const done   = currentIndex > stageIdx || currentStage === 'done'
        const active = STAGE_ORDER[currentIndex] === key
        const isWrite = key === 'write'

        return (
          <div key={key}>
            {/* 节点行 */}
            <div
              aria-current={active ? 'step' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 7px',
                borderRadius: '6px',
                border: `1.5px solid ${active ? 'var(--accent-active)' : done ? 'var(--accent-done)' : 'transparent'}`,
                background: active ? '#fff3e8' : done ? '#f5f0e8' : 'transparent',
                transition: 'all 0.2s',
              }}
            >
              {/* 图标 */}
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '5px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '10px',
                fontWeight: 700,
                flexShrink: 0,
                background: done ? 'var(--accent-done)' : active ? 'var(--accent-active)' : 'var(--stage-idle-bg)',
                color: done || active ? 'var(--text-on-accent)' : 'var(--text-muted)',
                animationName: active ? 'pulse-ring' : 'none',
                animationDuration: '2s',
                animationTimingFunction: 'ease-in-out',
                animationIterationCount: 'infinite',
              }}>
                {done ? '✓' : icon}
              </div>

              {/* 名称 */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '11px',
                  fontWeight: active ? 600 : 400,
                  color: done ? 'var(--accent-done)' : active ? 'var(--accent-active)' : 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {label}
                  {isWrite && totalChapters > 0 && (
                    <span style={{ opacity: 0.7, marginLeft: '3px' }}>
                      {completedChapters}/{totalChapters}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 章节子步骤（仅 write 阶段 active 时展开） */}
            {isWrite && active && outline.length > 0 && (
              <div style={{
                borderLeft: '2px solid var(--accent-active)',
                marginLeft: '17px',
                paddingLeft: '8px',
                marginTop: '3px',
                marginBottom: '3px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              }}>
                {outline.map((title) => {
                  const status = chapterStatus[title]
                  const isDone = status === 'done'
                  const isActive = !!status && !isDone
                  return (
                    <div key={title} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '10px',
                      padding: '2px 4px',
                      borderRadius: '4px',
                      background: isActive ? 'rgba(249,115,22,0.06)' : 'transparent',
                    }}>
                      <div style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: isDone
                          ? 'var(--accent-done)'
                          : isActive
                          ? 'var(--accent-active)'
                          : 'var(--stage-idle-bg)',
                      }} />
                      <span style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: isDone ? 'var(--accent-done)' : isActive ? 'var(--accent-active)' : 'var(--text-muted)',
                        fontWeight: isActive ? 600 : 400,
                      }}>
                        {title}
                      </span>
                      {status && (
                        <span style={{
                          flexShrink: 0,
                          color: isDone ? 'var(--accent-done)' : 'var(--text-muted)',
                          fontSize: '9px',
                        }}>
                          {CH_STATUS_LABEL[status] ?? status}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* 节点间连接线 */}
            {i < STAGES.length - 1 && (
              <div style={{
                width: '2px',
                height: '8px',
                background: done ? 'var(--accent-done)' : 'var(--stage-idle-bg)',
                margin: '1px 0 1px 16px',
                borderRadius: '1px',
                transition: 'background 0.3s',
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}
