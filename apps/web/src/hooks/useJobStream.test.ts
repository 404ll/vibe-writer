import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useJobStream } from './useJobStream'
import { SSE_EVENT_GROUPS, SSE_EVENT_TYPES, TERMINAL_EVENTS } from '../sseEvents'

describe('useJobStream', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('EventSource', vi.fn())
  })

  function streamResponse(chunks: string[]) {
    const encoder = new TextEncoder()
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
          controller.close()
        },
      }),
    }
  }

  it('streams job events with fetch instead of EventSource', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(streamResponse([]) as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) } as Response)

    renderHook(() => useJobStream('job-123', vi.fn()))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/jobs/job-123/stream', {
        signal: expect.any(AbortSignal),
      })
    })
    expect(EventSource).not.toHaveBeenCalled()
  })

  it('calls onEvent when a streamed event frame arrives', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(streamResponse([
        'event: outline_ready\n',
        'data: {"outline":["ch1"]}\n\n',
      ]) as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ events: [] }) } as Response)

    const onEvent = vi.fn()
    renderHook(() => useJobStream('job-123', onEvent))

    await waitFor(() => {
      expect(onEvent).toHaveBeenCalledWith('outline_ready', { outline: ['ch1'] })
    })
  })

  it('replays historical events and ignores duplicate streamed events by sequence', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(streamResponse([
        'event: outline_ready\n',
        'data: {"outline":["old"],"_seq":0}\n\n',
        'event: writing_chapter\n',
        'data: {"title":"ch1","token":"hello","_seq":1}\n\n',
      ]) as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          events: [
            { event: 'outline_ready', data: { outline: ['old'], _seq: 0 } },
          ],
        }),
      } as Response)

    const onEvent = vi.fn()
    renderHook(() => useJobStream('job-123', onEvent))

    await waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith('writing_chapter', {
        title: 'ch1',
        token: 'hello',
      })
    )
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('groups SSE events by frontend workflow area', () => {
    expect(SSE_EVENT_GROUPS.lifecycle).toEqual(['done', 'cancelled', 'error'])
    expect(SSE_EVENT_GROUPS.planning).toEqual(['stage_update', 'outline_ready'])
    expect(SSE_EVENT_GROUPS.chapter).toEqual([
      'generating_opinions',
      'opinions_ready',
      'searching',
      'search_done',
      'writing_chapter',
      'reviewing_chapter',
      'chapter_done',
    ])
    expect(SSE_EVENT_GROUPS.review).toEqual(['reviewing_full', 'review_done'])
    expect(SSE_EVENT_TYPES).toEqual([
      ...SSE_EVENT_GROUPS.lifecycle,
      ...SSE_EVENT_GROUPS.planning,
      ...SSE_EVENT_GROUPS.chapter,
      ...SSE_EVENT_GROUPS.review,
    ])
    expect([...TERMINAL_EVENTS]).toEqual(SSE_EVENT_GROUPS.lifecycle)
  })
})
