import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'

const API_BASE = 'http://localhost:8000'

const SSE_EVENT_TYPES: SSEEventType[] = [
  'stage_update',
  'outline_ready',
  'chapter_done',
  'done',
  'error',
]

export function useJobStream(
  jobId: string | null,
  onEvent: (type: SSEEventType, data: Record<string, unknown>) => void
) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!jobId) return

    const es = new EventSource(`${API_BASE}/jobs/${jobId}/stream`)

    SSE_EVENT_TYPES.forEach((type) => {
      es.addEventListener(type, (e: MessageEvent) => {
        const data = JSON.parse(e.data)
        onEventRef.current(type, data)
      })
    })

    return () => es.close()
  }, [jobId])
}
