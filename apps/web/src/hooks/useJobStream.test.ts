import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useJobStream } from './useJobStream'
import { SSE_EVENT_GROUPS, SSE_EVENT_TYPES, TERMINAL_EVENTS } from '../sseEvents'

describe('useJobStream', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [] }),
    }))
    vi.stubGlobal('EventSource', vi.fn().mockImplementation(function () {
      return {
        addEventListener: vi.fn(),
        close: vi.fn(),
      }
    }))
  })

  it('creates EventSource with correct URL', () => {
    renderHook(() => useJobStream('job-123', vi.fn()))
    expect(EventSource).toHaveBeenCalledWith(
      '/api/jobs/job-123/stream'
    )
  })

  it('calls onEvent when message arrives', () => {
    const listeners: Record<string, Function> = {}
    vi.stubGlobal('EventSource', vi.fn().mockImplementation(function () {
      return {
        addEventListener: (type: string, fn: Function) => { listeners[type] = fn },
        close: vi.fn(),
      }
    }))

    const onEvent = vi.fn()
    renderHook(() => useJobStream('job-123', onEvent))

    act(() => {
      listeners['outline_ready']?.({ data: JSON.stringify({ outline: ['ch1'] }) })
    })

    expect(onEvent).toHaveBeenCalledWith('outline_ready', { outline: ['ch1'] })
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
