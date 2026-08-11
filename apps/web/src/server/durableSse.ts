import {
  TERMINAL_EVENTS,
  type JobEvent,
  type SSEEventType,
} from '@vibe-writer/contracts/sse'

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
