import type { WorkspaceScope } from '@vibe-writer/db'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export const PRINCIPAL_HEADER = 'x-vibe-principal-id'
export const WORKSPACE_HEADER = 'x-vibe-workspace-id'

export type RequestIdentityResult =
  | { status: 'parsed'; scope: WorkspaceScope }
  | { status: 'auth_unconfigured' }
  | { status: 'unauthenticated' }

type IdentityEnvironment = {
  NODE_ENV?: NodeJS.ProcessEnv['NODE_ENV']
  DURABLE_AUTH_MODE?: string
  DURABLE_LOCAL_PRINCIPAL_ID?: string
  DURABLE_LOCAL_WORKSPACE_ID?: string
}

export function parseRequestIdentity(
  headers: Pick<Headers, 'get'>,
  authMode = process.env.DURABLE_AUTH_MODE,
  environment: IdentityEnvironment = process.env,
): RequestIdentityResult {
  if (authMode === 'local-development') {
    if (environment.NODE_ENV !== 'development') {
      return { status: 'auth_unconfigured' }
    }
    const principalId = environment.DURABLE_LOCAL_PRINCIPAL_ID?.trim()
    const workspaceId = environment.DURABLE_LOCAL_WORKSPACE_ID?.trim()
    if (
      !principalId || !workspaceId ||
      !UUID_PATTERN.test(principalId) || !UUID_PATTERN.test(workspaceId)
    ) {
      return { status: 'auth_unconfigured' }
    }
    return { status: 'parsed', scope: { principalId, workspaceId } }
  }
  if (authMode !== 'trusted-proxy') return { status: 'auth_unconfigured' }
  const principalId = headers.get(PRINCIPAL_HEADER)?.trim()
  const workspaceId = headers.get(WORKSPACE_HEADER)?.trim()
  if (
    !principalId || !workspaceId ||
    !UUID_PATTERN.test(principalId) || !UUID_PATTERN.test(workspaceId)
  ) {
    return { status: 'unauthenticated' }
  }
  return { status: 'parsed', scope: { principalId, workspaceId } }
}
