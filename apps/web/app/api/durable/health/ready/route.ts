import {
  checkDurableDatabaseReadiness,
  durableApiEnabled,
  durableMemoryManagementApiEnabled,
  durableMemorySignalApiEnabled,
  getMemoryConsentPolicyVersion,
} from '../../../../../src/server/durableDatabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function notReady(
  reason: 'disabled' | 'configuration_invalid' | 'dependency_unavailable',
): Response {
  return Response.json(
    { status: 'not_ready', reason },
    { status: 503, headers: { 'cache-control': 'no-store' } },
  )
}

export async function GET(): Promise<Response> {
  if (!durableApiEnabled()) return notReady('disabled')
  const memoryEnabled =
    durableMemorySignalApiEnabled() || durableMemoryManagementApiEnabled()
  if (
    memoryEnabled &&
    !getMemoryConsentPolicyVersion()
  ) {
    return notReady('configuration_invalid')
  }
  try {
    if (!await checkDurableDatabaseReadiness({ includeMemory: memoryEnabled })) {
      return notReady('dependency_unavailable')
    }
    return Response.json(
      { status: 'ready' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    )
  } catch {
    return notReady('dependency_unavailable')
  }
}
