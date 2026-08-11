import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  enabled: vi.fn(),
  memoryEnabled: vi.fn(),
  memoryManagementEnabled: vi.fn(),
  memoryPolicyVersion: vi.fn(),
  ready: vi.fn(),
}))

vi.mock('../../../../src/server/durableDatabase', () => ({
  durableApiEnabled: durable.enabled,
  durableMemorySignalApiEnabled: durable.memoryEnabled,
  durableMemoryManagementApiEnabled: durable.memoryManagementEnabled,
  getMemoryConsentPolicyVersion: durable.memoryPolicyVersion,
  checkDurableDatabaseReadiness: durable.ready,
}))

import { GET as live } from './live/route'
import { GET as ready } from './ready/route'

describe('durable API health routes', () => {
  beforeEach(() => {
    durable.enabled.mockReset()
    durable.ready.mockReset()
    durable.memoryEnabled.mockReturnValue(false)
    durable.memoryManagementEnabled.mockReturnValue(false)
    durable.memoryPolicyVersion.mockReturnValue(null)
  })

  it('keeps liveness independent from feature enablement and dependencies', async () => {
    const response = await live()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ status: 'live' })
  })

  it('fails readiness closed while the durable API is disabled', async () => {
    durable.enabled.mockReturnValue(false)
    const response = await ready()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      status: 'not_ready',
      reason: 'disabled',
    })
    expect(durable.ready).not.toHaveBeenCalled()
  })

  it('requires the database and all durable relations', async () => {
    durable.enabled.mockReturnValue(true)
    durable.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const unavailable = await ready()
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({
      reason: 'dependency_unavailable',
    })
    const available = await ready()
    expect(available.status).toBe(200)
    await expect(available.json()).resolves.toEqual({ status: 'ready' })
    expect(durable.ready).toHaveBeenCalledWith({ includeMemory: false })
  })

  it('fails readiness when the Memory signal API lacks a versioned consent policy', async () => {
    durable.enabled.mockReturnValue(true)
    durable.memoryEnabled.mockReturnValue(true)
    const response = await ready()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      status: 'not_ready',
      reason: 'configuration_invalid',
    })
    expect(durable.ready).not.toHaveBeenCalled()
  })

  it('also requires a registered policy for the Memory management UI', async () => {
    durable.enabled.mockReturnValue(true)
    durable.memoryManagementEnabled.mockReturnValue(true)
    const response = await ready()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      reason: 'configuration_invalid',
    })
    expect(durable.ready).not.toHaveBeenCalled()
  })
})
