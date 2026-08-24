import {
  TERMINAL_EVENTS,
  type SSEEventType,
} from '@vibe-writer/contracts/jobs/event-types'
import type { JobEvent } from '@vibe-writer/contracts/jobs/events'

export type DurableEventSource = {
  listEventsAfter(jobId: string, afterSeq: number): Promise<JobEvent[]>
}

export type DurableSseOptions = {
  jobId: string
  afterSeq: number
  signal: AbortSignal
  source: DurableEventSource
  pollIntervalMs?: number
  keepaliveIntervalMs?: number
}

const encoder = new TextEncoder()

export function encodeSseEvent(event: JobEvent): Uint8Array {
  return encoder.encode(
    `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
  )
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function eventSeq(event: JobEvent): number {
  const seq = event.data._seq
  if (seq === undefined) throw new Error('Durable event is missing _seq')
  return seq
}

export function createDurableEventStream(
  options: DurableSseOptions,
): ReadableStream<Uint8Array> {
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? 15_000
  if (pollIntervalMs <= 0 || keepaliveIntervalMs <= 0) {
    throw new Error('SSE intervals must be positive')
  }

  // 服务端推送是 PostgreSQL 事件日志的可重放投影，不是内存广播。连接断开后客户端
  // 只需携带最后的 _seq；下一次轮询会从同一事实来源补齐缺失事件。
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let afterSeq = options.afterSeq
        let lastWriteAt = Date.now()
        try {
          while (!options.signal.aborted) {
            const events = await options.source.listEventsAfter(options.jobId, afterSeq)
            for (const event of events) {
              if (options.signal.aborted) break
              controller.enqueue(encodeSseEvent(event))
              afterSeq = eventSeq(event)
              lastWriteAt = Date.now()
              if (TERMINAL_EVENTS.has(event.event as SSEEventType)) {
                controller.close()
                return
              }
            }
            if (options.signal.aborted) break
            if (Date.now() - lastWriteAt >= keepaliveIntervalMs) {
              controller.enqueue(encoder.encode(': keepalive\n\n'))
              lastWriteAt = Date.now()
            }
            await abortableDelay(pollIntervalMs, options.signal)
          }
          controller.close()
        } catch (error) {
          if (options.signal.aborted) controller.close()
          else controller.error(error)
        }
      })()
    },
  })
}
