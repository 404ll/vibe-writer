import { describe, expect, it } from 'vitest'
import {
  WebExtractProviderError,
  WebExtractService,
  type WebPageExtractor,
} from '../src/web-extract'

function failingExtractor(error: Error): WebPageExtractor {
  return {
    async extract() {
      throw error
    },
  }
}

describe('WebExtractService', () => {
  it('converts provider unavailability into a structured fail-soft result', async () => {
    const service = new WebExtractService(failingExtractor(
      new WebExtractProviderError('offline', 'unavailable', true, { provider: 'readability' }),
    ))

    await expect(service.extract({ url: 'https://example.com/article' })).resolves.toEqual({
      status: 'unavailable',
      url: 'https://example.com/article',
      reason: 'unavailable',
      retryable: true,
      provider: 'readability',
    })
  })

  it('does not turn extraction failures into source content', async () => {
    const service = new WebExtractService(failingExtractor(
      new WebExtractProviderError('blocked', 'unsafe_url', false, { provider: 'readability' }),
    ))

    await expect(service.extract({ url: 'https://example.com/article' })).resolves.toEqual({
      status: 'failed',
      url: 'https://example.com/article',
      reason: 'unsafe_url',
      retryable: false,
      provider: 'readability',
    })
  })

  it('propagates cancellation so the workflow can stop promptly', async () => {
    const cancellation = new WebExtractProviderError('cancelled', 'cancelled', false)
    const service = new WebExtractService(failingExtractor(cancellation))

    await expect(service.extract({ url: 'https://example.com/article' })).rejects.toBe(cancellation)
  })
})
