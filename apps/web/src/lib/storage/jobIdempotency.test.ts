import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PENDING_JOB_IDEMPOTENCY_STORAGE_KEY,
  clearPendingJobIdempotencyKey,
  resolveJobIdempotencyKey,
} from './jobIdempotency'

const firstKey = '11111111-1111-4111-8111-111111111111'
const secondKey = '22222222-2222-4222-8222-222222222222'
const thirdKey = '33333333-3333-4333-8333-333333333333'

describe('job idempotency key', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(firstKey)
      .mockReturnValueOnce(secondKey)
      .mockReturnValueOnce(thirdKey)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses one client key while the same create request is still in flight', () => {
    const request = { topic: 'RAG 检索', style: '技术博客', target_words: 1200, intervention: { on_outline: true } }

    expect(resolveJobIdempotencyKey(request)).toBe(`job-ui-${firstKey}`)
    expect(resolveJobIdempotencyKey(request)).toBe(`job-ui-${firstKey}`)
    expect(window.sessionStorage.getItem(PENDING_JOB_IDEMPOTENCY_STORAGE_KEY)).toContain(firstKey)
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('issues a new key after success or when the next submit changes payload', () => {
    const first = { topic: 'RAG 检索', intervention: { on_outline: true } }
    const second = { topic: '另一篇', intervention: { on_outline: false } }

    expect(resolveJobIdempotencyKey(first)).toBe(`job-ui-${firstKey}`)
    expect(resolveJobIdempotencyKey(second)).toBe(`job-ui-${secondKey}`)

    clearPendingJobIdempotencyKey()
    expect(window.sessionStorage.getItem(PENDING_JOB_IDEMPOTENCY_STORAGE_KEY)).toBeNull()
    expect(resolveJobIdempotencyKey(first)).toBe(`job-ui-${thirdKey}`)
  })
})
