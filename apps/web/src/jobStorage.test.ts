import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVE_JOB_STORAGE_KEY,
  clearActiveJobId,
  readActiveJobId,
  useActiveJobId,
  writeActiveJobId,
} from './jobStorage'

describe('active job storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('writes only the versioned minimal pointer', () => {
    writeActiveJobId('job-123')

    expect(window.localStorage.getItem(ACTIVE_JOB_STORAGE_KEY)).toBe('job-123')
    expect(readActiveJobId()).toBe('job-123')
  })

  it('notifies the client hook when the pointer changes', () => {
    const { result } = renderHook(() => useActiveJobId())
    expect(result.current).toBeNull()

    act(() => writeActiveJobId('job-456'))
    expect(result.current).toBe('job-456')

    act(() => clearActiveJobId())
    expect(result.current).toBeNull()
  })
})
