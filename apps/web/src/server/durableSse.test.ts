import type { JobEvent } from '@vibe-writer/contracts/jobs/events'
import { describe, expect, it, vi } from 'vitest'
import { createDurableEventStream, encodeSseEvent } from './durableSse'

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return output + decoder.decode()
    output += decoder.decode(value, { stream: true })
  }
}

describe('durable SSE read model', () => {
  it('encodes the shared event/data frame without exposing repository rows', () => {
    const event = {
      event: 'stage_update',
      data: { stage: 'write', _seq: 3 },
    } satisfies JobEvent
    expect(new TextDecoder().decode(encodeSseEvent(event))).toBe(
      'event: stage_update\ndata: {"stage":"write","_seq":3}\n\n',
    )
  })

  it('polls after the last sequence and closes on a terminal event', async () => {
    const source = {
      listEventsAfter: vi
        .fn()
        .mockResolvedValueOnce([
          { event: 'stage_update', data: { stage: 'export', _seq: 4 } },
        ])
        .mockResolvedValueOnce([
          {
            event: 'done',
            data: { output_path: null, article_id: 'article-1', _seq: 5 },
          },
        ]),
    }
    const body = await readAll(
      createDurableEventStream({
        jobId: 'job-1',
        afterSeq: 3,
        signal: new AbortController().signal,
        source,
        pollIntervalMs: 1,
        keepaliveIntervalMs: 60_000,
      }),
    )

    expect(source.listEventsAfter).toHaveBeenNthCalledWith(1, 'job-1', 3)
    expect(source.listEventsAfter).toHaveBeenNthCalledWith(2, 'job-1', 4)
    expect(body).toContain('event: stage_update')
    expect(body).toContain('event: done')
    expect(body).toContain('"_seq":5')
  })

  it('closes an idle stream when the request is aborted', async () => {
    const controller = new AbortController()
    const source = { listEventsAfter: vi.fn(async () => []) }
    const reading = readAll(
      createDurableEventStream({
        jobId: 'job-abort',
        afterSeq: -1,
        signal: controller.signal,
        source,
        pollIntervalMs: 5,
        keepaliveIntervalMs: 60_000,
      }),
    )
    controller.abort()
    await expect(reading).resolves.toBe('')
  })
})
