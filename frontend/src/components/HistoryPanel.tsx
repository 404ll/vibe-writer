import { useEffect, useState } from 'react'
import type { JobState } from '../types'

interface HistoryEntry {
  id: string
  topic: string
  timestamp: number
  success: boolean
}

const STORAGE_KEY = 'vibe-writer-history'

function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveHistory(entries: HistoryEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-50)))
}

interface Props {
  currentJob: JobState | null
  currentTopic: string
}

export function HistoryPanel({ currentJob, currentTopic }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>(loadHistory)

  useEffect(() => {
    if (!currentJob || (currentJob.stage !== 'done' && currentJob.stage !== 'error')) return
    if (!currentJob.jobId) return

    setEntries((prev) => {
      if (prev.some((e) => e.id === currentJob.jobId)) return prev
      const next: HistoryEntry[] = [
        ...prev,
        {
          id: currentJob.jobId,
          topic: currentTopic,
          timestamp: Date.now(),
          success: currentJob.stage === 'done',
        },
      ]
      saveHistory(next)
      return next
    })
  }, [currentJob?.stage, currentJob?.jobId, currentTopic])

  return (
    <div
      className="card"
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div className="card-label">历史记录</div>
      {entries.length === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>暂无记录</p>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {[...entries].reverse().map((entry) => (
            <div
              key={entry.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 10px',
                background: 'var(--input-bg)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                fontSize: '13px',
                color: 'var(--text)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: '8px', height: '8px',
                  borderRadius: '50%',
                  background: entry.success ? 'var(--success)' : 'var(--danger)',
                  flexShrink: 0,
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.topic || entry.id}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
                {new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(entry.timestamp))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
