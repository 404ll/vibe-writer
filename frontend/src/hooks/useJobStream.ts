import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'

const API_BASE = 'http://localhost:8000'

// 需要监听的所有 SSE 事件类型（与后端 SSEEvent.event 字段保持一致）
const SSE_EVENT_TYPES: SSEEventType[] = [
  'stage_update',
  'outline_ready',
  'generating_opinions',
  'opinions_ready',
  'searching',
  'writing_chapter',
  'reviewing_chapter',
  'chapter_done',
  'reviewing_full',
  'review_done',
  'done',
  'cancelled',
  'error',
]

const TERMINAL_EVENTS = new Set(['done', 'cancelled', 'error'])

/**
 * 管理 SSE 长连接的自定义 Hook，支持断点续连。
 *
 * 重连流程：
 * 1. 先 GET /jobs/{id}/events 拉取历史事件并回放（幂等：重复事件不影响 UI）
 * 2. 再建立 SSE 长连接接收新事件
 *
 * @param jobId  - 要订阅的 Job ID；传 null 时不建立连接
 * @param onEvent - 收到事件时的回调
 */
export function useJobStream(
  jobId: string | null,
  onEvent: (type: SSEEventType, data: Record<string, unknown>) => void
) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!jobId) return

    let es: EventSource | null = null
    let cancelled = false

    async function connect() {
      // Step 1: 回放历史事件
      try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/events`)
        if (!res.ok || cancelled) return
        const { events } = await res.json() as { events: Array<{ event: string; data: Record<string, unknown> }> }
        console.log('[useJobStream] replaying', events.length, 'events')
        for (const e of events) {
          if (cancelled) return
          onEventRef.current(e.event as SSEEventType, e.data)
        }
      } catch (err) {
        console.error('[useJobStream] replay error', err)
      }

      // Step 2: 建立 SSE 长连接接收新事件
      if (cancelled) return
      es = new EventSource(`${API_BASE}/jobs/${jobId}/stream`)

      SSE_EVENT_TYPES.forEach((type) => {
        es!.addEventListener(type, (e: MessageEvent) => {
          const data = JSON.parse(e.data)
          onEventRef.current(type, data)
          if (TERMINAL_EVENTS.has(type)) {
            es?.close()
          }
        })
      })
    }

    connect()

    return () => {
      cancelled = true
      es?.close()
    }
  }, [jobId])
}
