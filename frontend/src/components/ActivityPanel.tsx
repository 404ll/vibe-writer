import { useEffect, useRef } from 'react'
import type { ActivityEntry } from '../types'

interface Props {
  entries: ActivityEntry[]
}

const STATUS_ICON: Record<ActivityEntry['status'], string> = {
  running: '◌',
  success: '✦',
  failed:  '✕',
  info:    '◎',
}

const STATUS_COLOR: Record<ActivityEntry['status'], string> = {
  running: 'var(--accent-active)',
  success: 'var(--success)',
  failed:  'var(--danger)',
  info:    'var(--text-muted)',
}

const STATUS_BG: Record<ActivityEntry['status'], string> = {
  running: 'transparent',
  success: 'var(--success-bg)',
  failed:  'var(--danger-bg)',
  info:    'transparent',
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
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: 'calc(55vh - 28px)',
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
                gap: '7px',
                padding: '4px 6px',
                marginBottom: '2px',
                borderRadius: '5px',
                fontSize: '12px',
                lineHeight: '1.5',
                background: STATUS_BG[entry.status],
                animationName: 'slideInRight',
                animationDuration: '0.2s',
                animationTimingFunction: 'ease-out',
                animationFillMode: 'both',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  color: STATUS_COLOR[entry.status],
                  flexShrink: 0,
                  width: '13px',
                  fontSize: '11px',
                  marginTop: '1px',
                  display: 'inline-block',
                  animationName: entry.status === 'running' ? 'spin' : 'none',
                  animationDuration: '1.2s',
                  animationTimingFunction: 'linear',
                  animationIterationCount: 'infinite',
                }}
              >
                {STATUS_ICON[entry.status]}
              </span>
              <span style={{
                color: entry.status === 'failed' ? 'var(--danger)'
                     : entry.status === 'success' ? 'var(--success-text)'
                     : 'var(--text)',
                flex: 1,
              }}>
                {entry.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
