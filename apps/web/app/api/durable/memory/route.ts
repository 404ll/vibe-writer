import { MemoryManagementPageQuerySchema } from '@vibe-writer/contracts/memory/management/shared'
import { ListActiveMemoriesResponseSchema } from '@vibe-writer/contracts/memory/management/records'
import {
  authorizeDurableHeaders,
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
  getWorkspaceDurableRepositories,
} from '../../../../src/server/durableDatabase'
import {
  durableAuthorizationFailure,
  durableMemoryManagementUnavailable,
  invalidRequest,
} from '../../../../src/server/durableHttp'
import {
  decodeDurableUuidCursor,
  encodeDurableUuidCursor,
} from '../../../../src/server/durableCursor'
import {
  memoryManagementRepositoryFailure,
  toActiveMemory,
} from '../../../../src/server/durableMemoryManagement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  if (!durableApiEnabled() || !durableMemoryManagementApiEnabled()) {
    return durableMemoryManagementUnavailable()
  }
  const authorization = await authorizeDurableHeaders(request.headers)
  if (authorization.status !== 'authorized') {
    return durableAuthorizationFailure(authorization.status)
  }
  const url = new URL(request.url)
  const query = MemoryManagementPageQuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  })
  if (!query.success) return invalidRequest()
  const cursor = query.data.cursor
    ? decodeDurableUuidCursor(query.data.cursor)
    : undefined
  if (query.data.cursor && !cursor) return invalidRequest('Invalid Memory cursor.')
  try {
    const page = await getWorkspaceDurableRepositories(authorization.scope).memory.listPage({
      limit: query.data.limit,
      ...(cursor ? { cursor } : {}),
    })
    return Response.json(
      ListActiveMemoriesResponseSchema.parse({
        memories: page.items.map(toActiveMemory),
        next_cursor: page.nextCursor
          ? encodeDurableUuidCursor(page.nextCursor)
          : null,
      }),
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return memoryManagementRepositoryFailure(error)
  }
}
