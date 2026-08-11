import { describe, expect, it, vi } from 'vitest'
import { loadLiveEvalSamplerConfig } from '../src/live-sampler-config.ts'
import { LiveEvalSamplerLoop } from '../src/live-sampler.ts'

describe('live Eval sampler process loop', () => {
  it('runs immediately, polls with bounded inputs, and shuts down cleanly', async () => {
    const scanActivePolicies = vi.fn(async () => undefined)
    const loop = new LiveEvalSamplerLoop({ scanActivePolicies }, {
      pollIntervalMs: 10,
      policyLimit: 3,
      sourceBatchSize: 7,
      onError: vi.fn(),
    })
    await loop.start()
    expect(scanActivePolicies).toHaveBeenCalledWith({ policyLimit: 3, sourceBatchSize: 7 })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(scanActivePolicies.mock.calls.length).toBeGreaterThanOrEqual(2)
    await loop.close()
    const countAtClose = scanActivePolicies.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scanActivePolicies).toHaveBeenCalledTimes(countAtClose)
  })

  it('reports a scan failure and continues polling', async () => {
    const expected = new Error('temporary database failure')
    const scanActivePolicies = vi.fn()
      .mockRejectedValueOnce(expected)
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    const loop = new LiveEvalSamplerLoop({ scanActivePolicies }, {
      pollIntervalMs: 5,
      policyLimit: 1,
      sourceBatchSize: 1,
      onError,
    })
    await loop.start()
    expect(onError).toHaveBeenCalledWith(expected)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(scanActivePolicies.mock.calls.length).toBeGreaterThanOrEqual(2)
    await loop.close()
  })

  it('requires an explicit enable flag and database URL', () => {
    expect(() => loadLiveEvalSamplerConfig({})).toThrow(
      'EVAL_LIVE_SAMPLER_ENABLED must equal true',
    )
    expect(() => loadLiveEvalSamplerConfig({ EVAL_LIVE_SAMPLER_ENABLED: 'true' }))
      .toThrow('DATABASE_EVAL_LIVE_SAMPLER_URL is required')
    expect(loadLiveEvalSamplerConfig({
      EVAL_LIVE_SAMPLER_ENABLED: 'true',
      DATABASE_EVAL_LIVE_SAMPLER_URL: 'postgres://eval_sampler@localhost/eval',
      EVAL_LIVE_SAMPLER_DATABASE_ROLE: 'eval_sampler',
    })).toMatchObject({
      database: {
        url: 'postgres://eval_sampler@localhost/eval',
        role: 'eval_sampler',
      },
      pollIntervalMs: 5_000,
      policyLimit: 20,
      sourceBatchSize: 100,
    })
  })
})
