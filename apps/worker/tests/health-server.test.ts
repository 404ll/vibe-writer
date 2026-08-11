import { describe, expect, it } from 'vitest'
import { WorkerHealthServer } from '../src/health-server'

describe('worker health state', () => {
  it('rejects invalid readiness transitions without opening a listener', async () => {
    const health = new WorkerHealthServer({ host: '127.0.0.1', port: 1 })
    health.markDraining()
    expect(() => health.markReady()).toThrow('draining')
    await expect(health.close()).resolves.toBeUndefined()
    await expect(health.close()).resolves.toBeUndefined()
  })
})
