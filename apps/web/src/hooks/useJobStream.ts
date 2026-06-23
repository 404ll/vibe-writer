import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'
import { API_BASE } from '../config'
import { SSE_EVENT_TYPES, TERMINAL_EVENTS } from '../sseEvents'

type RawEvent = { event: string; data: Record<string, unknown> }
type ParsedStreamEvent = { event: string; data: Record<string, unknown> }

function parseSSEFrame(frame: string): ParsedStreamEvent | null {
  let event = 'message'
  const dataLines: string[] = []

  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue

    const separatorIndex = line.indexOf(':')
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      dataLines.push(value)
    }
  }

  if (dataLines.length === 0) return null

  try {
    return {
      event,
      data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
    }
  } catch (err) {
    console.error('[useJobStream] parse event error', err)
    return null
  }
}

/**
 * 管理 SSE 长连接的自定义 Hook，支持断点续连。
 *
 * 重连流程：
 * 1. 用 fetch 建立服务端事件流连接（尽早订阅，减少漏事件窗口）
 * 2. GET /jobs/{id}/events 回放历史（按 _seq 去重）
 * 3. 通过 ReadableStream 持续解析 event/data frame
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

    let cancelled = false
    let stoppedByTerminalEvent = false
    const controller = new AbortController()
    // 后端每个事件会带递增的 _seq，用它过滤历史回放和实时推送里的重复事件。
    let lastSeq = -1

    //把一个后端事件正式交给前端页面处理
    function dispatch(type: string, data: Record<string, unknown>) {
      if (!SSE_EVENT_TYPES.includes(type as SSEEventType)) return

      const seq = data._seq as number | undefined
      if (seq !== undefined) {
        if (seq <= lastSeq) return
        lastSeq = seq
      }
      // _seq 只用于前端去重，不继续传给页面层业务逻辑。
      const { _seq: _, ...payload } = data
      onEventRef.current(type as SSEEventType, payload)
    }

    function dispatchStreamFrame(frame: string) {
      const parsed = parseSSEFrame(frame)
      if (!parsed) return

      dispatch(parsed.event, parsed.data)
      if (TERMINAL_EVENTS.has(parsed.event as SSEEventType)) {
        stoppedByTerminalEvent = true
        controller.abort()
      }
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

    async function sleep(ms: number) {
      await new Promise((resolve) => setTimeout(resolve, ms))
    }

    async function readStream(response: Response) {
      if (!response.body) return

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          let boundaryIndex = buffer.search(/\r?\n\r?\n/)
          while (boundaryIndex !== -1) {
            const frame = buffer.slice(0, boundaryIndex)
            const boundaryMatch = buffer.slice(boundaryIndex).match(/^\r?\n\r?\n/)
            buffer = buffer.slice(boundaryIndex + (boundaryMatch?.[0].length ?? 2))
            dispatchStreamFrame(frame)
            boundaryIndex = buffer.search(/\r?\n\r?\n/)
          }
        }

        buffer += decoder.decode()
        if (buffer.trim()) {
          dispatchStreamFrame(buffer)
        }
      } finally {
        reader.releaseLock()
      }
    }

    async function connect() {
      const res = await fetch(`${API_BASE}/jobs/${jobId}/stream`, {
        signal: controller.signal,
      })
      if (!res.ok || cancelled) return

      // 连接建立后再回放一次，补齐“开始连接”和“连接成功”之间可能漏掉的事件。
      await replayEvents(lastSeq)
      await readStream(res)
    }

    async function connectLoop() {
      while (!cancelled && !stoppedByTerminalEvent) {
        try {
          await connect()
        } catch (err) {
          if (!cancelled && !controller.signal.aborted) {
            console.error('[useJobStream] stream error', err)
          }
        }

        if (!cancelled && !stoppedByTerminalEvent) {
          await sleep(1000)
          if (!cancelled && !stoppedByTerminalEvent) {
            await replayEvents(lastSeq)
          }
        }
      }
    }

    void connectLoop()

    return () => {
      // 组件卸载或 jobId 改变时，停止后续异步处理并关闭旧连接。
      cancelled = true
      controller.abort()
    }
  }, [jobId])
}
