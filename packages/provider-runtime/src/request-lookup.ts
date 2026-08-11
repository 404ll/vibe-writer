import { createHash } from 'node:crypto'
import { z } from 'zod'

const IdentifierSchema = z.string().trim().min(1).max(256)
const RequestIdSchema = z.string().trim().min(1).max(512)
const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const TokenCountSchema = z.number().int().min(0).max(2_147_483_647)

export const ProviderRequestLookupInputSchema = z.object({
  provider: IdentifierSchema,
  model: IdentifierSchema,
  requestId: RequestIdSchema,
}).strict()

export const ProviderRequestUsageSchema = z.object({
  inputTokens: TokenCountSchema,
  outputTokens: TokenCountSchema,
  cacheReadInputTokens: TokenCountSchema.optional(),
  cacheWriteInputTokens: TokenCountSchema.optional(),
}).strict()

const LookupIdentitySchema = z.object({
  provider: IdentifierSchema,
  model: IdentifierSchema,
  requestId: RequestIdSchema,
}).strict()

export const ProviderRequestLookupResultSchema = z.discriminatedUnion('status', [
  LookupIdentitySchema.extend({
    status: z.literal('succeeded'),
    evidenceFingerprint: FingerprintSchema,
    usage: ProviderRequestUsageSchema,
  }).strict(),
  LookupIdentitySchema.extend({
    status: z.literal('failed'),
    evidenceFingerprint: FingerprintSchema,
    failureCode: z.string().trim().regex(/^[a-z0-9][a-z0-9_.:-]*$/).max(256),
    usage: ProviderRequestUsageSchema,
  }).strict(),
  LookupIdentitySchema.extend({ status: z.literal('pending') }).strict(),
  LookupIdentitySchema.extend({ status: z.literal('not_found') }).strict(),
])

export type ProviderRequestLookupInput = z.infer<typeof ProviderRequestLookupInputSchema>
export type ProviderRequestLookupResult = z.infer<typeof ProviderRequestLookupResultSchema>

export interface ProviderRequestLookup {
  readonly provider: string
  lookup(
    input: ProviderRequestLookupInput & { signal?: AbortSignal },
  ): Promise<ProviderRequestLookupResult>
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

export function fingerprintProviderLookupEvidence(value: ProviderRequestLookupResult): string {
  const normalized = ProviderRequestLookupResultSchema.parse(value)
  const digest = createHash('sha256').update(canonical(normalized)).digest('hex')
  return `sha256:${digest}`
}

export type ScriptedProviderRequestLookupOptions = {
  provider: string
  records: Readonly<Record<string, ProviderRequestLookupResult>>
}

export class ScriptedProviderRequestLookup implements ProviderRequestLookup {
  readonly provider: string
  private readonly records: Readonly<Record<string, ProviderRequestLookupResult>>

  constructor(options: ScriptedProviderRequestLookupOptions) {
    this.provider = IdentifierSchema.parse(options.provider)
    this.records = options.records
  }

  async lookup(
    input: ProviderRequestLookupInput & { signal?: AbortSignal },
  ): Promise<ProviderRequestLookupResult> {
    const query = ProviderRequestLookupInputSchema.parse(input)
    if (query.provider !== this.provider) {
      throw new Error('Provider request lookup adapter identity collision')
    }
    if (input.signal?.aborted) throw input.signal.reason
    const raw = this.records[query.requestId]
    if (!raw) return { ...query, status: 'not_found' }
    const result = ProviderRequestLookupResultSchema.parse(raw)
    if (
      result.provider !== query.provider ||
      result.model !== query.model ||
      result.requestId !== query.requestId
    ) {
      throw new Error('Provider request lookup result identity collision')
    }
    return result
  }
}
