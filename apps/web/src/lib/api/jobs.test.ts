import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob } from './jobs'
import { PENDING_JOB_IDEMPOTENCY_STORAGE_KEY } from '@/lib/storage/jobIdempotency'

const jobId = '33333333-3333-4333-8333-333333333333'
const requestKey = '44444444-4444-4444-8444-444444444444'

describe('createJob client', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestKey)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the job body with a stable Idempotency-Key and clears the pending key on success', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json({ job_id: jobId }))
    vi.stubGlobal('fetch', fetchMock)

    const request = {
      topic: 'Agent 工程化',
      intervention: { on_outline: true },
      style: '技术博客',
      target_words: 800,
    }
    await expect(createJob(request)).resolves.toEqual({ job_id: jobId })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('/api/durable/jobs')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `job-ui-${requestKey}`,
      },
    })
    expect(JSON.parse(String(init?.body))).toEqual(request)
    expect(window.sessionStorage.getItem(PENDING_JOB_IDEMPOTENCY_STORAGE_KEY)).toBeNull()
  })

  it('keeps the pending key when create fails so a retry can replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))

    await expect(createJob({ topic: '失败重试' })).rejects.toThrow('Failed to create job')
    expect(window.sessionStorage.getItem(PENDING_JOB_IDEMPOTENCY_STORAGE_KEY)).toContain(requestKey)
  })
})
