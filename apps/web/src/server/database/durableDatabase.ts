import 'server-only'

import {
  createArticleRepository,
  createCommandRepository,
  createJobRepository,
  createPostgresDatabase,
  createWorkspaceRepository,
  createWorkspaceScopedRepositories,
  type AuthorizedWorkspaceScope,
} from '@vibe-writer/db'
import type { MemoryConsentPolicyDocument } from '@vibe-writer/contracts/memory-policy'
import { getRegisteredMemoryConsentPolicy } from '@/server/memory/memoryConsentPolicies'
import { parseRequestIdentity } from '@/server/identity/requestIdentity'

type DurableDatabase = ReturnType<typeof createPostgresDatabase>

const durableGlobal = globalThis as typeof globalThis & {
  __vibeWriterDurableDatabase?: DurableDatabase
}

export function durableApiEnabled(): boolean {
  return process.env.DURABLE_API_ENABLED === 'true'
}

export function durableMemorySignalApiEnabled(): boolean {
  return process.env.DURABLE_MEMORY_SIGNAL_API_ENABLED === 'true'
}

export function durableMemoryManagementApiEnabled(): boolean {
  return process.env.DURABLE_MEMORY_MANAGEMENT_API_ENABLED === 'true'
}

export function getMemoryConsentPolicyVersion(): string | null {
  return getMemoryConsentPolicy()?.version ?? null
}

export function getMemoryConsentPolicy(): MemoryConsentPolicyDocument | null {
  return getRegisteredMemoryConsentPolicy(process.env.MEMORY_CONSENT_POLICY_VERSION)
}

export function getDurableDatabaseUrl(
  environment?: { DATABASE_API_URL?: string },
): string {
  const connectionString = (
    environment?.DATABASE_API_URL ?? process.env.DATABASE_API_URL
  )?.trim()
  if (!connectionString) throw new Error('DATABASE_API_URL is required for the Durable API')
  return connectionString
}

export function getDurableDatabase(): DurableDatabase {
  durableGlobal.__vibeWriterDurableDatabase ??= createPostgresDatabase(
    getDurableDatabaseUrl(),
    { max: process.env.VERCEL === '1' ? 1 : 10 },
  )
  return durableGlobal.__vibeWriterDurableDatabase
}

export function getDurableRepositories() {
  const { db } = getDurableDatabase()
  return {
    articles: createArticleRepository(db),
    jobs: createJobRepository(db),
    commands: createCommandRepository(db),
  }
}

export function getWorkspaceDurableRepositories(scope: AuthorizedWorkspaceScope) {
  return createWorkspaceScopedRepositories(getDurableDatabase().db, scope)
}

export type DurableAuthorization =
  | { status: 'authorized'; scope: AuthorizedWorkspaceScope }
  | { status: 'auth_unconfigured' | 'unauthenticated' | 'forbidden' }

// 授权检查
export async function authorizeDurableHeaders(
  headers: Pick<Headers, 'get'>,
): Promise<DurableAuthorization> {
  const identity = parseRequestIdentity(headers)
  if (identity.status !== 'parsed') return identity
  const scope = await createWorkspaceRepository(getDurableDatabase().db)
    .authorize(identity.scope)
  return scope ? { status: 'authorized', scope } : { status: 'forbidden' }
}

export async function checkDurableDatabaseReadiness(
  options: { includeMemory?: boolean } = {},
): Promise<boolean> {
  const { client } = getDurableDatabase()
  const [core] = await client<{ ready: boolean }[]>`
    select (
      to_regclass('public.jobs') is not null
      and to_regclass('public.runs') is not null
      and to_regclass('public.job_events') is not null
      and to_regclass('public.outbox_events') is not null
      and to_regclass('public.run_effects') is not null
      and to_regclass('public.checkpoint_attempts') is not null
      and to_regclass('public.job_interrupts') is not null
      and to_regclass('public.job_commands') is not null
      and to_regclass('public.articles') is not null
      and to_regclass('public.article_versions') is not null
      and to_regclass('public.principals') is not null
      and to_regclass('public.principal_identities') is not null
      and to_regclass('public.workspaces') is not null
      and to_regclass('public.workspace_memberships') is not null
    ) as ready
  `
  if (core?.ready !== true || options.includeMemory !== true) {
    return core?.ready === true
  }
  const [memory] = await client<{ ready: boolean }[]>`
    select (
      to_regclass('public.memory_source_signals') is not null
      and to_regclass('public.memory_source_signal_tombstones') is not null
      and to_regclass('public.memory_candidates') is not null
      and to_regclass('public.memories') is not null
      and to_regclass('public.memory_revisions') is not null
      and to_regclass('public.memory_candidate_events') is not null
      and to_regclass('public.memory_tombstones') is not null
    ) as ready
  `
  return memory?.ready === true
}
