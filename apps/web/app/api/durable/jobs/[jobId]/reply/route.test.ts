import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  enabled: vi.fn(),
  authorize: vi.fn(),
  submitOutlineReply: vi.fn(),
}))

vi.mock('@/server/database/durableDatabase', () => ({
  durableApiEnabled: durable.enabled,
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    commands: { submitOutlineReply: durable.submitOutlineReply },
  }),
}))

import { POST } from './route'

const context = { params: Promise.resolve({ jobId: 'job-1' }) }

describe('durable outline reply route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    durable.enabled.mockReturnValue(true)
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role: 'owner',
        authorization: 'verified-membership',
      },
    })
    durable.submitOutlineReply.mockResolvedValue({ status: 'queued' })
  })

  it('rejects an outline that cannot fit the durable graph state', async () => {
    const response = await POST(new Request('http://localhost/reply', {
      method: 'POST',
      body: JSON.stringify({
        message: '',
        outline: Array.from({ length: 7 }, (_, index) => `第 ${index + 1} 章`),
      }),
    }), context)

    expect(response.status).toBe(400)
    expect(durable.submitOutlineReply).not.toHaveBeenCalled()
  })

  it('keeps empty-message direct outline confirmation compatible', async () => {
    const response = await POST(new Request('http://localhost/reply', {
      method: 'POST',
      body: JSON.stringify({ message: '', outline: ['第一章'] }),
    }), context)

    expect(response.status).toBe(200)
    expect(durable.submitOutlineReply).toHaveBeenCalledWith({
      jobId: 'job-1',
      reply: { message: '', outline: ['第一章'] },
    })
  })
})
