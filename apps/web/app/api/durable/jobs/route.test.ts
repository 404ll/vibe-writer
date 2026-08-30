import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  enabled: vi.fn(),
  authorize: vi.fn(),
  createJob: vi.fn(),
}))

vi.mock('@/server/database/durableDatabase', () => ({
  durableApiEnabled: durable.enabled,
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    jobs: { createJob: durable.createJob },
  }),
}))

import { POST } from './route'

describe('durable jobs route', () => {
  beforeEach(() => {
    durable.enabled.mockReset()
    durable.createJob.mockReset()
    durable.authorize.mockReset()
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role: 'owner',
        authorization: 'verified-membership',
      },
    })
  })

  it('rejects requests when the trusted identity boundary is missing', async () => {
    durable.enabled.mockReturnValue(true)
    durable.authorize.mockResolvedValue({ status: 'unauthenticated' })
    const response = await POST(new Request('http://localhost/api/durable/jobs', {
      method: 'POST',
      body: JSON.stringify({ topic: 'No identity' }),
    }))
    expect(response.status).toBe(401)
    expect(durable.createJob).not.toHaveBeenCalled()
  })

  it('allows viewers to read elsewhere but rejects job creation', async () => {
    durable.enabled.mockReturnValue(true)
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role: 'viewer',
        authorization: 'verified-membership',
      },
    })
    const response = await POST(new Request('http://localhost/api/durable/jobs', {
      method: 'POST',
      body: JSON.stringify({ topic: 'Viewer write' }),
    }))
    expect(response.status).toBe(403)
    expect(durable.createJob).not.toHaveBeenCalled()
  })

  it('is fail-closed until the durable API flag is explicitly enabled', async () => {
    durable.enabled.mockReturnValue(false)
    const response = await POST(
      new Request('http://localhost/api/durable/jobs', {
        method: 'POST',
        body: JSON.stringify({ topic: 'Disabled' }),
      }),
    )
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      detail: 'Durable API is not enabled.',
    })
    expect(durable.createJob).not.toHaveBeenCalled()
  })

  it('validates the shared request and forwards an idempotency key', async () => {
    durable.enabled.mockReturnValue(true)
    durable.createJob.mockResolvedValue({
      job: { id: '11111111-1111-4111-8111-111111111111' },
      created: true,
    })
    const response = await POST(
      new Request('http://localhost/api/durable/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'request-1',
        },
        body: JSON.stringify({ topic: 'Durable route' }),
      }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      job_id: '11111111-1111-4111-8111-111111111111',
    })
    expect(durable.createJob).toHaveBeenCalledWith({
      topic: 'Durable route',
      style: '',
      intervention: { on_outline: true },
      idempotencyKey: 'request-1',
    })
  })

  it('rejects malformed JSON without touching the repository', async () => {
    durable.enabled.mockReturnValue(true)
    const response = await POST(
      new Request('http://localhost/api/durable/jobs', {
        method: 'POST',
        body: '{',
      }),
    )
    expect(response.status).toBe(400)
    expect(durable.createJob).not.toHaveBeenCalled()
  })
})
