import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readability } from '@mozilla/readability'
import {
  WebExtractProviderError,
  type WebExtractProviderRequest,
  type WebPageExtractor,
} from '@vibe-writer/agent-core'
import { WebExtractProviderResponseSchema } from '@vibe-writer/contracts/research'
import { parseHTML } from 'linkedom'

type ResolvedAddress = { address: string; family: 4 | 6 }
export type PublicDnsResolver = (hostname: string) => Promise<ResolvedAddress[]>

export type SafeWebExtractorOptions = {
  timeoutMs?: number
  maxResponseBytes?: number
  maxTextChars?: number
  maxRedirects?: number
  resolve?: PublicDnsResolver
  request?: SafeHttpRequest
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
])

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0
}

function inV4Range(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask)
}

function normalizedIp(address: string): string {
  const lower = address.toLowerCase()
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)
  if (mapped?.[1]) return mapped[1]
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u)
  if (!mappedHex) return lower
  const high = Number.parseInt(mappedHex[1]!, 16)
  const low = Number.parseInt(mappedHex[2]!, 16)
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.')
}

/** 阻断 loopback/private/link-local/metadata/benchmark/multicast 等非公网地址。 */
export function isPublicAddress(rawAddress: string): boolean {
  const address = normalizedIp(rawAddress)
  const family = isIP(address)
  if (family === 4) {
    return ![
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => inV4Range(address, base as string, prefix as number))
  }
  if (family === 6) {
    // 公网 IPv6 当前属于 2000::/3；收紧为该范围，并排除文档前缀。
    // IPv4-mapped、ULA、link-local、multicast、NAT64 等因此默认拒绝。
    return /^[23]/u.test(address) && !address.startsWith('2001:db8:')
  }
  return false
}

function parsePublicUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch (error) {
    throw new WebExtractProviderError('Web page URL is invalid.', 'unsafe_url', false, { cause: error, provider: 'readability' })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new WebExtractProviderError('Web page URL is not allowed.', 'unsafe_url', false, { provider: 'readability' })
  }
  if ((url.port && url.protocol === 'http:' && url.port !== '80') ||
      (url.port && url.protocol === 'https:' && url.port !== '443')) {
    throw new WebExtractProviderError('Web page URL port is not allowed.', 'unsafe_url', false, { provider: 'readability' })
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new WebExtractProviderError('Private network URL is not allowed.', 'unsafe_url', false, { provider: 'readability' })
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new WebExtractProviderError('Private network URL is not allowed.', 'unsafe_url', false, { provider: 'readability' })
  }
  return url
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const family = isIP(hostname)
  if (family) return [{ address: hostname, family: family as 4 | 6 }]
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.filter((entry): entry is ResolvedAddress => entry.family === 4 || entry.family === 6)
}

async function resolvePublic(url: URL, resolve: PublicDnsResolver): Promise<ResolvedAddress> {
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolve(url.hostname.replace(/^\[|\]$/gu, ''))
  } catch (error) {
    throw new WebExtractProviderError('Web page hostname could not be resolved.', 'unavailable', true, { cause: error, provider: 'readability' })
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WebExtractProviderError('Private network URL is not allowed.', 'unsafe_url', false, { provider: 'readability' })
  }
  return addresses[0]!
}

export type SafeHttpResult = {
  status: number
  contentType: string
  location?: string
  body: Buffer
}

export type SafeHttpRequest = (
  url: URL,
  address: ResolvedAddress,
  options: { timeoutMs: number; maxResponseBytes: number },
  signal?: AbortSignal,
) => Promise<SafeHttpResult>

function getOnce(
  url: URL,
  address: ResolvedAddress,
  options: Required<Pick<SafeWebExtractorOptions, 'timeoutMs' | 'maxResponseBytes'>>,
  signal?: AbortSignal,
): Promise<SafeHttpResult> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = transport({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'accept-encoding': 'identity',
        'user-agent': 'vibe-writer-web-extract/1.0',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      lookup: (_hostname, _options, callback) => {
        callback(null, address.address, address.family)
      },
    }, (response) => {
      const status = response.statusCode ?? 0
      const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase()
      const location = response.headers.location
      const contentLength = Number(response.headers['content-length'] ?? 0)
      if (contentLength > options.maxResponseBytes) {
        response.destroy()
        reject(new WebExtractProviderError('Web page response is too large.', 'response_too_large', false, { provider: 'readability' }))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > options.maxResponseBytes) {
          response.destroy(new WebExtractProviderError('Web page response is too large.', 'response_too_large', false, { provider: 'readability' }))
          return
        }
        chunks.push(chunk)
      })
      response.once('end', () => resolve({
        status,
        contentType,
        ...(location ? { location } : {}),
        body: Buffer.concat(chunks),
      }))
      response.once('error', reject)
    })
    const abort = () => request.destroy(new DOMException('Web extraction cancelled.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new WebExtractProviderError('Web page request timed out.', 'timeout', true, { provider: 'readability' }))
    })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.once('error', reject)
    request.end()
  })
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function readableHtml(html: string, url: URL): { title?: string; content: string } {
  const { document } = parseHTML(html)
  Object.defineProperty(document, 'URL', { configurable: true, value: url.toString() })
  const parsed = new Readability(document as unknown as Document).parse()
  const content = cleanText(parsed?.textContent ?? document.body?.textContent ?? '')
  const title = cleanText(parsed?.title ?? document.title ?? '')
  return { ...(title ? { title } : {}), content }
}

export class SafeReadabilityWebExtractor implements WebPageExtractor {
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly maxTextChars: number
  private readonly maxRedirects: number
  private readonly resolve: PublicDnsResolver
  private readonly request: SafeHttpRequest

  constructor(options: SafeWebExtractorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000
    this.maxTextChars = options.maxTextChars ?? 20_000
    this.maxRedirects = options.maxRedirects ?? 3
    this.resolve = options.resolve ?? defaultResolver
    this.request = options.request ?? getOnce
  }

  async extract(input: WebExtractProviderRequest) {
    const originalUrl = parsePublicUrl(input.url)
    let currentUrl = originalUrl
    let response: SafeHttpResult | undefined
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const address = await resolvePublic(currentUrl, this.resolve)
      try {
        response = await this.request(currentUrl, address, {
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
        }, input.signal)
      } catch (error) {
        if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new WebExtractProviderError('Web page request was cancelled.', 'cancelled', false, { cause: error, provider: 'readability' })
        }
        if (error instanceof WebExtractProviderError) throw error
        throw new WebExtractProviderError('Web page is unavailable.', 'unavailable', true, { cause: error, provider: 'readability' })
      }
      if (response.status >= 300 && response.status < 400 && response.location) {
        if (redirect === this.maxRedirects) {
          throw new WebExtractProviderError('Web page redirected too many times.', 'provider_error', false, { provider: 'readability' })
        }
        currentUrl = parsePublicUrl(new URL(response.location, currentUrl).toString())
        continue
      }
      break
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw new WebExtractProviderError('Web page request failed.', 'unavailable', true, { provider: 'readability' })
    }
    if (!ALLOWED_CONTENT_TYPES.has(response.contentType)) {
      throw new WebExtractProviderError('Web page content type is not supported.', 'unsupported_content_type', false, { provider: 'readability' })
    }
    const raw = response.body.toString('utf8')
    const extracted = response.contentType === 'text/plain'
      ? { content: cleanText(raw) }
      : readableHtml(raw, currentUrl)
    if (!extracted.content) {
      throw new WebExtractProviderError('Web page did not contain readable text.', 'empty_content', false, { provider: 'readability' })
    }
    const truncated = extracted.content.length > this.maxTextChars
    const projected = WebExtractProviderResponseSchema.safeParse({
      provider: 'readability',
      url: originalUrl.toString(),
      finalUrl: currentUrl.toString(),
      ...extracted,
      content: extracted.content.slice(0, this.maxTextChars),
      contentType: response.contentType,
      truncated,
    })
    if (!projected.success) {
      throw new WebExtractProviderError('Web extractor returned an invalid response.', 'invalid_response', false, { provider: 'readability' })
    }
    return projected.data
  }
}
