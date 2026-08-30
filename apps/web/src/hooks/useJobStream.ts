import { useEffect, useRef } from 'react'
import type { SSEEventType } from '@/types'
import { API_BASE } from '@/lib/config'
import { parseSseFrame, takeCompleteSseFrames } from '@/lib/sseText'
import { SSE_EVENT_TYPES, TERMINAL_EVENTS } from '@/lib/sseEvents'

type RawEvent = { event: string; data: Record<string, unknown> }
type EventSourceKind = 'stream' | 'history'

function debugSSE(stage: string, details?: Record<string, unknown>) {
  if (process.env.NODE_ENV !== 'development') return
  console.debug(`[SSE] ${stage}`, details ?? '')
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
    let lastSeq = -1 // 上次处理的事件序列号

    // 分发事件：本质上是对返回的事件做去重处理
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
      // 调用onEvent回调函数
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
      const parsed = parseSseFrame(frame)
      if (!parsed) return
      debugSSE('4. 文本帧已解析为事件对象', {
        event: parsed.event,
        seq: parsed.data._seq,
        dataKeys: Object.keys(parsed.data),
      })

      dispatchEvent(parsed.event, parsed.data, 'stream')
    }

    // 历史回放
    async function replayEvents(fromSeq: number): Promise<void> {
      try {
        const res = await fetch(`${API_BASE}/jobs/${jobId}/events`)
        if (!res.ok || cancelled) return
        const { events } = await res.json() as { events: RawEvent[] }
        debugSSE('历史回放已返回', {
          fromSeq,
          eventCount: events.length,
        })
        // 遍历事件，分发事件
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

    // 读取流：切分并分发 SSE 帧
    async function readStream(response: Response) {
      if (!response.body) return

      const reader = response.body.getReader() // 读取器
      const decoder = new TextDecoder() // 解码器
      let buffer = '' // 缓冲区

      try {
        while (!cancelled) {
          const { done, value } = await reader.read() // 读取器读取数据
          if (done) break

          const textChunk = decoder.decode(value, { stream: true }) // 解码器解码数据
          buffer += textChunk
          debugSSE('2. 收到并解码一个响应字节块', {
            byteLength: value.byteLength,
            textChars: textChunk.length,
            bufferedChars: buffer.length,
          })

          const { frames, rest } = takeCompleteSseFrames(buffer) // 切分并分发 SSE 帧
          buffer = rest
          // 遍历帧，分发帧
          for (const frame of frames) dispatchStreamFrame(frame)
        }

        buffer += decoder.decode()
        if (buffer.trim()) {
          dispatchStreamFrame(buffer)
        }
      } finally {
        reader.releaseLock()
      }
    }

    // 建立 SSE 长连接
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

    //没结束就一直连；断了等 1 秒再连
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
