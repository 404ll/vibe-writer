import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useJobStream } from './useJobStream'

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
})
