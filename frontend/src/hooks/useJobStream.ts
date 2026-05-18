import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'
import { API_BASE } from '../config'

// 需要监听的所有 SSE 事件类型（与后端 SSEEvent.event 字段保持一致）
const SSE_EVENT_TYPES: SSEEventType[] = [
  'stage_update',
  'outline_ready',
  'generating_opinions',
  'opinions_ready',
  'searching',
  'search_done',
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

type RawEvent = { event: string; data: Record<string, unknown> }

/**
 * 管理 SSE 长连接的自定义 Hook，支持断点续连。
 *
 * 重连流程：
 * 1. 建立 SSE 长连接（尽早订阅，减少漏事件窗口）
 * 2. GET /jobs/{id}/events 回放历史（按 _seq 去重）
 * 3. onopen 后再拉一次历史，补齐连接建立前的空隙
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
    let lastSeq = -1

    function dispatch(type: string, data: Record<string, unknown>) {
      const seq = data._seq as number | undefined
      if (seq !== undefined) {
        if (seq <= lastSeq) return
        lastSeq = seq
      }
      const { _seq: _, ...payload } = data
      onEventRef.current(type as SSEEventType, payload)
    }

    async function replayEvents(fromSeq: number): Promise<void> {
      try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/events`)
        if (!res.ok || cancelled) return
        const { events } = await res.json() as { events: RawEvent[] }
        for (const e of events) {
          if (cancelled) return
          const seq = e.data._seq as number | undefined
          if (seq !== undefined && seq <= fromSeq) continue
          dispatch(e.event, e.data)
        }
      } catch (err) {
        console.error('[useJobStream] replay error', err)
      }
    }

    async function connect() {
      es = new EventSource(`${API_BASE}/jobs/${jobId}/stream`)

      SSE_EVENT_TYPES.forEach((type) => {
        es!.addEventListener(type, (e: MessageEvent) => {
          const data = JSON.parse(e.data) as Record<string, unknown>
          dispatch(type, data)
          if (TERMINAL_EVENTS.has(type)) {
            es?.close()
          }
        })
      })

      es.addEventListener('open', () => {
        if (!cancelled) void replayEvents(lastSeq)
      })

      await replayEvents(lastSeq)
    }

    connect()

    return () => {
      cancelled = true
      es?.close()
    }
  }, [jobId])
}
