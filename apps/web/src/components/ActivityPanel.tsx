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

export function ActivityPanel({ entries }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  return (
    <div role="log" aria-label="任务进度日志" aria-live="polite" className="card activity-panel">
      <div className="card-label">实时日志</div>
      <div className="activity-scroll">
        {entries.length === 0 ? (
          <p className="activity-empty">等待任务开始…</p>
        ) : (
          entries.map((entry) => {
            const rowClass = [
              'activity-row',
              entry.status === 'success' ? 'activity-row--success' : '',
              entry.status === 'failed' ? 'activity-row--failed' : '',
            ].filter(Boolean).join(' ')
            const iconClass = [
              'activity-icon',
              entry.status === 'running' ? 'activity-icon--running' : '',
            ].filter(Boolean).join(' ')
            const messageClass = [
              entry.status === 'failed' ? 'activity-message--failed' : '',
              entry.status === 'success' ? 'activity-message--success' : '',
            ].filter(Boolean).join(' ')

            return (
              <div key={entry.id} className={rowClass}>
                <span aria-hidden="true" className={iconClass} style={{ color: STATUS_COLOR[entry.status] }}>
                  {STATUS_ICON[entry.status]}
                </span>
                <span className={messageClass} style={{ flex: 1 }}>
                  {entry.message}
                </span>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
