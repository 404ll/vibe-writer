import { and, eq, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { WorkspaceRole, WorkspaceScope } from '../domain'
import {
  principalIdentities,
  principals,
  workspaceMemberships,
  workspaces,
} from '../schema'
import type { VibeDatabase } from './jobs'

export type AuthorizedWorkspaceScope = WorkspaceScope & {
  readonly authorization: 'verified-membership'
  readonly role: WorkspaceRole
}

export class WorkspacePermissionError extends Error {
  readonly name = 'WorkspacePermissionError'
}

export function requireWorkspaceEditor(scope: AuthorizedWorkspaceScope): void {
  if (scope.role === 'viewer') {
    throw new WorkspacePermissionError('Workspace editor permission is required')
  }
}

export function requireWorkspaceOwner(scope: AuthorizedWorkspaceScope): void {
  if (scope.role !== 'owner') {
    throw new WorkspacePermissionError('Workspace owner permission is required')
  }
}

export type ProvisionWorkspaceInput = WorkspaceScope & {
  slug: string
  name: string
  role?: WorkspaceRole
  displayName?: string
  identity?: { issuer: string; subject: string }
}

export class WorkspaceRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async provision(input: ProvisionWorkspaceInput): Promise<AuthorizedWorkspaceScope> {
    return this.db.transaction(async (tx) => {
      await tx.insert(principals).values({
        id: input.principalId,
        displayName: input.displayName ?? null,
      }).onConflictDoNothing({ target: principals.id })
      if (input.identity) {
        await tx.insert(principalIdentities).values({
          ...input.identity,
          principalId: input.principalId,
        }).onConflictDoNothing({
          target: [principalIdentities.issuer, principalIdentities.subject],
        })
      }
      await tx.insert(workspaces).values({
        id: input.workspaceId,
        slug: input.slug,
        name: input.name,
      }).onConflictDoNothing({ target: workspaces.id })
      await tx.insert(workspaceMemberships).values({
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        role: input.role ?? 'owner',
      }).onConflictDoNothing({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.principalId],
      })
      const authorized = await this.authorizeInDatabase({
        workspaceId: input.workspaceId,
        principalId: input.principalId,
      }, tx as unknown as VibeDatabase<TQueryResult>)
      if (!authorized) throw new Error('Workspace provisioning did not create an active membership')
      return authorized
    })
  }

  async resolveIdentity(issuer: string, subject: string): Promise<string | null> {
    const [identity] = await this.db
      .select({ principalId: principalIdentities.principalId })
      .from(principalIdentities)
      .innerJoin(principals, eq(principals.id, principalIdentities.principalId))
      .where(
        and(
          eq(principalIdentities.issuer, issuer),
          eq(principalIdentities.subject, subject),
          eq(principals.status, 'active'),
        ),
      )
      .limit(1)
    return identity?.principalId ?? null
  }

  async authorize(
    scope: WorkspaceScope,
  ): Promise<AuthorizedWorkspaceScope | null> {
    return this.db.transaction(async (tx) => {
      const database = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(database, scope)
      return this.authorizeInDatabase(scope, database)
    })
  }

  private async authorizeInDatabase(
    scope: WorkspaceScope,
    database: VibeDatabase<TQueryResult>,
  ): Promise<AuthorizedWorkspaceScope | null> {
    const [membership] = await database
      .select({ role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .innerJoin(principals, eq(principals.id, workspaceMemberships.principalId))
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(
        and(
          eq(workspaceMemberships.workspaceId, scope.workspaceId),
          eq(workspaceMemberships.principalId, scope.principalId),
          eq(principals.status, 'active'),
          eq(workspaces.status, 'active'),
        ),
      )
      .limit(1)
    return membership
      ? { ...scope, role: membership.role, authorization: 'verified-membership' }
      : null
  }
}

export async function setWorkspaceSession<TQueryResult extends PgQueryResultHKT>(
  database: VibeDatabase<TQueryResult>,
  scope: WorkspaceScope,
): Promise<void> {
  await database.execute(sql`
    select
      set_config('app.principal_id', ${scope.principalId}, true),
      set_config('app.workspace_id', ${scope.workspaceId}, true)
  `)
}

export function createWorkspaceRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new WorkspaceRepository(db)
}
