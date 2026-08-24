import { useEffect, useRef } from 'react'
import type { SSEEventType } from '../types'
import { API_BASE } from '../config'
import { SSE_EVENT_TYPES, TERMINAL_EVENTS } from '../sseEvents'

type RawEvent = { event: string; data: Record<string, unknown> }
type ParsedStreamEvent = { event: string; data: Record<string, unknown> }
type EventSourceKind = 'stream' | 'history'

function debugSSE(stage: string, details?: Record<string, unknown>) {
  if (process.env.NODE_ENV !== 'development') return
  console.debug(`[SSE] ${stage}`, details ?? '')
}

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
    const parsed = {
      event,
      data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
    }
    debugSSE('4. 文本帧已解析为事件对象', {
      event: parsed.event,
      seq: parsed.data._seq,
      dataKeys: Object.keys(parsed.data),
    })
    return parsed
  } catch (err) {
    console.error('[useJobStream] parse event error', err)
    return null
  }
}

export function useJobStream(
  jobId: string | null,
  onEvent: (type: SSEEventType, data: Record<string, unknown>) => void
) {
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!jobId) return

    let cancelled = false
    let stoppedByTerminalEvent = false
    const controller = new AbortController()
    let lastSeq = -1

    function dispatch(
      type: string,
      data: Record<string, unknown>,
      source: EventSourceKind,
    ): boolean {
      if (!SSE_EVENT_TYPES.includes(type as SSEEventType)) {
        debugSSE('5. 忽略未知事件', { source, type })
        return false
      }

      const seq = data._seq as number | undefined
      if (seq !== undefined) {
        if (seq <= lastSeq) {
          debugSSE('5. _seq 去重：丢弃重复或过期事件', {
            source,
            type,
            seq,
            lastSeq,
          })
          return false
        }
        debugSSE('5. _seq 去重：接受新事件', {
          source,
          type,
          seq,
          previousLastSeq: lastSeq,
        })
        lastSeq = seq
      }
      // _seq 只用于前端去重，不继续传给页面层业务逻辑。
      const payload = { ...data }
      delete payload._seq
      debugSSE('6. 事件交给 App.handleEvent()', {
        source,
        type,
        payloadKeys: Object.keys(payload),
      })
      onEventRef.current(type as SSEEventType, payload)
      return true
    }

    function dispatchEvent(
      type: string,
      data: Record<string, unknown>,
      source: EventSourceKind,
    ): boolean {
      if (!dispatch(type, data, source)) return false
      if (!TERMINAL_EVENTS.has(type as SSEEventType)) return false

      debugSSE('7. 收到终止事件，关闭 SSE 连接', {
        source,
        event: type,
        seq: data._seq,
      })
      stoppedByTerminalEvent = true
      controller.abort()
      return true
    }

    function dispatchStreamFrame(frame: string) {
      debugSSE('3. buffer 已切出一个完整 SSE 帧', {
        frameChars: frame.length,
        firstLine: frame.split(/\r?\n/, 1)[0],
      })
      const parsed = parseSSEFrame(frame)
      if (!parsed) return

      dispatchEvent(parsed.event, parsed.data, 'stream')
    }

    async function replayEvents(fromSeq: number): Promise<void> {
      try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/events`)
        if (!res.ok || cancelled) return
        const { events } = await res.json() as { events: RawEvent[] }
        debugSSE('历史回放已返回', {
          fromSeq,
          eventCount: events.length,
        })
        for (const e of events) {
          if (cancelled) return
          const seq = e.data._seq as number | undefined
          if (seq !== undefined && seq <= fromSeq) continue
          if (dispatchEvent(e.event, e.data, 'history')) break
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

          const textChunk = decoder.decode(value, { stream: true })
          buffer += textChunk
          debugSSE('2. 收到并解码一个响应字节块', {
            byteLength: value.byteLength,
            textChars: textChunk.length,
            bufferedChars: buffer.length,
          })

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
      debugSSE('1. 开始建立 SSE 长连接', { jobId })
      const res = await fetch(`${API_BASE}/jobs/${jobId}/stream`, {
        signal: controller.signal,
      })
      if (!res.ok || cancelled) {
        debugSSE('1. SSE 连接未建立', {
          jobId,
          status: res.status,
          cancelled,
        })
        if (!cancelled && res.status === 404) {
          dispatchEvent(
            'error',
            { message: '任务不存在或后端已重启，请重新创建任务' },
            'stream',
          )
        }
        return
      }
      debugSSE('1. SSE 长连接已建立', { jobId, status: res.status })

      await replayEvents(lastSeq)
      if (!stoppedByTerminalEvent) await readStream(res)
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
          debugSSE('连接中断，1 秒后重连', { jobId, lastSeq })
          await sleep(1000)
          if (!cancelled && !stoppedByTerminalEvent) {
            await replayEvents(lastSeq)
          }
        }
      }
    }

    void connectLoop()

    return () => {
      debugSSE('Hook 清理：主动关闭旧连接', { jobId, lastSeq })
      cancelled = true
      controller.abort()
    }
  }, [jobId])
}
