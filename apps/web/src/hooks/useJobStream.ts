import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'
import { API_BASE } from '../config'
import { SSE_EVENT_TYPES, TERMINAL_EVENTS } from '../sseEvents'

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
  // EventSource 的回调只注册一次；用 ref 保存最新的 onEvent，避免回调里拿到旧函数。
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!jobId) return

    let es: EventSource | null = null
    let cancelled = false
    // 后端每个事件会带递增的 _seq，用它过滤历史回放和实时推送里的重复事件。
    let lastSeq = -1

    //把一个后端事件正式交给前端页面处理
    function dispatch(type: string, data: Record<string, unknown>) {
      const seq = data._seq as number | undefined
      if (seq !== undefined) {
        if (seq <= lastSeq) return
        lastSeq = seq
      }
      // _seq 只用于前端去重，不继续传给页面层业务逻辑。
      const { _seq: _, ...payload } = data
      onEventRef.current(type as SSEEventType, payload)
    }

    async function replayEvents(fromSeq: number): Promise<void> {
      try {
        // 拉取后端保存过的历史事件，用来补齐页面刷新或网络重连期间错过的消息。
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
      // EventSource 会和后端保持一条 HTTP 长连接，后端有新事件时会主动推送。
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
        // 连接真正打开后再回放一次，补齐“创建连接”和“连接成功”之间可能漏掉的事件。
        if (!cancelled) void replayEvents(lastSeq)
      })

      await replayEvents(lastSeq)
    }

    connect()

    return () => {
      // 组件卸载或 jobId 改变时，停止后续异步处理并关闭旧连接。
      cancelled = true
      es?.close()
    }
  }, [jobId])
}
