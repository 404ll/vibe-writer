export function durableUnavailable(): Response {
  return Response.json(
    { detail: 'Durable API is not enabled.' },
    { status: 503 },
  )
}

export function durableMemorySignalUnavailable(): Response {
  return Response.json(
    { detail: 'Durable Memory signal API is not enabled.' },
    { status: 503 },
  )
}

export function durableMemorySignalConfigurationUnavailable(): Response {
  return Response.json(
    { detail: 'Durable Memory signal API configuration is incomplete.' },
    { status: 503 },
  )
}

export function durableMemoryManagementUnavailable(): Response {
  return Response.json(
    { detail: 'Durable Memory management API is not enabled.' },
    { status: 503 },
  )
}

export function durableMemoryPolicyUnavailable(): Response {
  return Response.json(
    { detail: 'Durable Memory policy API is not enabled.' },
    { status: 503 },
  )
}

export function durableMemoryPolicyConfigurationUnavailable(): Response {
  return Response.json(
    { detail: 'Durable Memory consent policy is not registered.' },
    { status: 503 },
  )
}

export function invalidRequest(detail = 'Invalid request.'): Response {
  return Response.json({ detail }, { status: 400 })
}

export function durableAuthUnavailable(): Response {
  return Response.json(
    { detail: 'Durable API authentication is not configured.' },
    { status: 503 },
  )
}

export function unauthorized(): Response {
  return Response.json({ detail: 'Authentication is required.' }, { status: 401 })
}

export function forbidden(): Response {
  return Response.json({ detail: 'Workspace access is denied.' }, { status: 403 })
}

export function durableAuthorizationFailure(
  status: 'auth_unconfigured' | 'unauthenticated' | 'forbidden',
): Response {
  if (status === 'auth_unconfigured') return durableAuthUnavailable()
  if (status === 'unauthenticated') return unauthorized()
  return forbidden()
}

export function notFound(detail = 'Job not found.'): Response {
  return Response.json({ detail }, { status: 404 })
}

export function conflict(detail = 'Job state conflict.'): Response {
  return Response.json({ detail }, { status: 409 })
}

export function idempotencyKeyRequired(): Response {
  return Response.json(
    { detail: 'Idempotency-Key is required.' },
    { status: 428 },
  )
}

export function memoryConsentPolicyConflict(currentPolicyVersion: string): Response {
  return Response.json(
    {
      detail: 'Memory consent policy version conflict.',
      current_policy_version: currentPolicyVersion,
    },
    { status: 409 },
  )
}

export function revisionConflict(currentRevision: number): Response {
  return Response.json(
    { detail: 'Article revision conflict.', current_revision: currentRevision },
    { status: 409 },
  )
}

export function preconditionRequired(): Response {
  return Response.json(
    { detail: 'expected_revision is required.' },
    { status: 428 },
  )
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  )
}

export function serverFailure(): Response {
  return Response.json({ detail: 'Durable API request failed.' }, { status: 500 })
}

export async function safeJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}
