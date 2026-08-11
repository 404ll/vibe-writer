import {
  CreateMemorySignalRequestSchema,
  CreateMemorySignalResponseSchema,
  ListMemorySignalsResponseSchema,
  MemorySignalIdempotencyKeySchema,
  MemorySignalPageQuerySchema,
} from '@vibe-writer/contracts/memory-signals'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemorySignalApiEnabled,
  getMemoryConsentPolicyVersion,
  getWorkspaceDurableRepositories,
} from '../../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableMemorySignalConfigurationUnavailable,
  durableMemorySignalUnavailable,
  idempotencyKeyRequired,
  invalidRequest,
  memoryConsentPolicyConflict,
  safeJson,
} from '../../../../../src/server/durableHttp'
import {
  decodeDurableUuidCursor,
  encodeDurableUuidCursor,
} from '../../../../../src/server/durableCursor'
import {
  memorySignalRepositoryFailure,
  toMemorySignal,
} from '../../../../../src/server/durableMemorySignals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function configuredPolicyVersion(): string | Response {
  if (!durableApiEnabled() || !durableMemorySignalApiEnabled()) {
    return durableMemorySignalUnavailable()
  }
  return getMemoryConsentPolicyVersion()
    ?? durableMemorySignalConfigurationUnavailable()
}

export async function GET(request: Request): Promise<Response> {
  const policyVersion = configuredPolicyVersion()
  if (policyVersion instanceof Response) return policyVersion
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const url = new URL(request.url)
  const query = MemorySignalPageQuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  })
  if (!query.success) return invalidRequest()
  const cursor = query.data.cursor
    ? decodeDurableUuidCursor(query.data.cursor)
    : undefined
  if (query.data.cursor && !cursor) return invalidRequest('Invalid Memory signal cursor.')
  try {
    const page = await getWorkspaceDurableRepositories(authorization.scope)
      .memorySourceSignals.listOwnPage({
        limit: query.data.limit,
        ...(cursor ? { cursor } : {}),
      })
    return Response.json(
      ListMemorySignalsResponseSchema.parse({
        signals: page.items.map(toMemorySignal),
        next_cursor: page.nextCursor
          ? encodeDurableUuidCursor(page.nextCursor)
          : null,
      }),
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return memorySignalRepositoryFailure(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const policyVersion = configuredPolicyVersion()
  if (policyVersion instanceof Response) return policyVersion
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const rawIdempotencyKey = request.headers.get('idempotency-key')
  if (!rawIdempotencyKey?.trim()) return idempotencyKeyRequired()
  const idempotencyKey = MemorySignalIdempotencyKeySchema.safeParse(rawIdempotencyKey)
  if (!idempotencyKey.success) return invalidRequest('Invalid Idempotency-Key.')
  const body = CreateMemorySignalRequestSchema.safeParse(await safeJson(request))
  if (!body.success) return invalidRequest()
  if (body.data.consent.policy_version !== policyVersion) {
    return memoryConsentPolicyConflict(policyVersion)
  }

  try {
    const result = await getWorkspaceDurableRepositories(authorization.scope)
      .memorySourceSignals.create({
        idempotencyKey: idempotencyKey.data,
        sourceKind: body.data.source_kind,
        subject: body.data.subject,
        text: body.data.text,
        consentPolicyVersion: policyVersion,
        retentionDays: body.data.retention_days,
        sourceRunId: body.data.source_run_id,
      })
    return Response.json(
      CreateMemorySignalResponseSchema.parse({
        signal: toMemorySignal(result.signal),
        created: result.created,
      }),
      {
        status: result.created ? 201 : 200,
        headers: {
          'cache-control': 'no-store',
          location: `/api/durable/memory/signals/${result.signal.id}`,
        },
      },
    )
  } catch (error) {
    return memorySignalRepositoryFailure(error)
  }
}
