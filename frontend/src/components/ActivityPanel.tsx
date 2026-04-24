import { useEffect, useRef } from 'react'
import type { ActivityEntry } from '../types'

interface Props {
  entries: ActivityEntry[]
}

const STATUS_ICON: Record<ActivityEntry['status'], string> = {
  running: '⟳',
  success: '✓',
  failed:  '✗',
  info:    '→',
}

const STATUS_COLOR: Record<ActivityEntry['status'], string> = {
  running: 'var(--accent)',
  success: 'var(--success)',
  failed:  'var(--danger)',
  info:    'var(--text-muted)',
}

export function ActivityPanel({ entries }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  return (
    <div
      role="log"
      aria-label="任务进度日志"
      aria-live="polite"
      className="card"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        padding: '14px 16px',
      }}
    >
      <div className="card-label">实时日志</div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {entries.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>等待任务开始…</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                padding: '4px 0',
                fontSize: '12.5px',
                lineHeight: '1.5',
                borderBottom: '1px solid var(--bg)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  color: STATUS_COLOR[entry.status],
                  flexShrink: 0,
                  width: '14px',
                  display: 'inline-block',
                  animationName: entry.status === 'running' ? 'spin' : 'none',
                  animationDuration: '1s',
                  animationTimingFunction: 'linear',
                  animationIterationCount: 'infinite',
                }}
              >
                {STATUS_ICON[entry.status]}
              </span>
              <span style={{ color: entry.status === 'failed' ? 'var(--danger)' : 'var(--text)' }}>
                {entry.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
        }
      `}</style>
    </div>
  )
}
