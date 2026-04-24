import { useEffect, useRef } from 'react'
import type { ActivityEntry } from '../types'

interface Props {
  entries: ActivityEntry[]
}

const STATUS_ICON: Record<ActivityEntry['status'], string> = {
  running: '⟳',
  success: '✓',
  failed: '✗',
  info: '→',
}

const STATUS_COLOR: Record<ActivityEntry['status'], string> = {
  running: '#2563eb',
  success: '#16a34a',
  failed: '#dc2626',
  info: '#64748b',
}

export function ActivityPanel({ entries }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // 新条目追加时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  if (entries.length === 0) return null

  return (
    <div
      role="log"
      aria-label="任务进度日志"
      aria-live="polite"
      style={{
        margin: '0 0 12px',
        border: '1px solid #e2e8f0',
        borderRadius: '6px',
        background: '#f8fafc',
        maxHeight: '240px',
        overflowY: 'auto',
        padding: '12px 16px',
      }}
    >
      {entries.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            padding: '3px 0',
            fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
            fontSize: '13px',
            lineHeight: '1.5',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              color: STATUS_COLOR[entry.status],
              flexShrink: 0,
              width: '16px',
              display: 'inline-block',
              animation: entry.status === 'running'
                ? 'spin 1s linear infinite'
                : undefined,
            }}
          >
            {STATUS_ICON[entry.status]}
          </span>
          <span style={{ color: entry.status === 'failed' ? '#dc2626' : '#334155' }}>
            {entry.message}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
      `}</style>
    </div>
  )
}
