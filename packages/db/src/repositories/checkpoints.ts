import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { LeaseIdentity, VibeDatabase } from './jobs'
import { checkpointAttempts, jobs, runs } from '../schema'
import type * as schema from '../schema'

const ROOT_CHECKPOINT_NAMESPACE = ''

export type CheckpointAuthorizationResult =
  | 'authorized'
  | 'cancel_requested'
  | 'lease_lost'
  | 'not_active'

export type PreparedCheckpointAttempt = {
  status: 'prepared' | 'existing'
  attempt: schema.CheckpointAttemptRow
}

export type PrepareCheckpointAttemptResult =
  | PreparedCheckpointAttempt
  | {
      status: 'incompatible_graph'
      sourceGraphVersion: string
      targetGraphVersion: string
    }
  | { status: 'cancel_requested' | 'lease_lost' }

export type ActivateCheckpointAttemptResult =
  | { status: 'activated' | 'replayed'; attempt: schema.CheckpointAttemptRow }
  | { status: 'cancel_requested' | 'lease_lost' | 'not_found' | 'invalid_fork' }

export type AdvanceCheckpointPointerResult =
  | { status: 'advanced' | 'replayed'; attempt: schema.CheckpointAttemptRow }
  | {
      status:
        | 'cancel_requested'
        | 'lease_lost'
        | 'not_active'
        | 'stale_checkpoint'
    }

function checkpointThreadId(identity: Pick<LeaseIdentity, 'jobId' | 'runId'>): string {
  return `job:${identity.jobId}:run:${identity.runId}`
}

function requireCheckpointId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw new Error('checkpointId must contain 1-256 non-whitespace characters')
  }
  return normalized
}

export class CheckpointRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async prepareCheckpointAttempt(
    identity: LeaseIdentity,
  ): Promise<PrepareCheckpointAttemptResult> {
    return this.db.transaction(async (tx) => {
      const authorization = await this.lockAuthorizedRun(tx, identity)
      if (authorization.status !== 'authorized') return authorization

      const [existing] = await tx
        .select()
        .from(checkpointAttempts)
        .where(eq(checkpointAttempts.runId, identity.runId))
        .limit(1)
      if (existing) {
        if (existing.status === 'superseded') return { status: 'lease_lost' as const }
        return { status: 'existing' as const, attempt: existing }
      }

      const [source] = await tx
        .select()
        .from(checkpointAttempts)
        .where(
          and(
            eq(checkpointAttempts.jobId, identity.jobId),
            eq(checkpointAttempts.status, 'active'),
          ),
        )
        .orderBy(desc(checkpointAttempts.activatedAt))
        .limit(1)

      if (
        source?.latestCheckpointId &&
        source.graphVersion !== authorization.graphVersion
      ) {
        return {
          status: 'incompatible_graph' as const,
          sourceGraphVersion: source.graphVersion,
          targetGraphVersion: authorization.graphVersion,
        }
      }

      const forkSource = source?.latestCheckpointId ? source : null
      const [attempt] = await tx
        .insert(checkpointAttempts)
        .values({
          jobId: identity.jobId,
          runId: identity.runId,
          checkpointThreadId: checkpointThreadId(identity),
          rootCheckpointNamespace: ROOT_CHECKPOINT_NAMESPACE,
          graphVersion: authorization.graphVersion,
          ...(forkSource
            ? {
                forkedFromRunId: forkSource.runId,
                forkedFromCheckpointThreadId: forkSource.checkpointThreadId,
                forkedFromCheckpointNamespace: forkSource.rootCheckpointNamespace,
                forkedFromCheckpointId: forkSource.latestCheckpointId,
              }
            : {}),
        })
        .returning()
      if (!attempt) throw new Error(`Checkpoint attempt creation failed for ${identity.runId}`)
      return { status: 'prepared' as const, attempt }
    })
  }

  async activateCheckpointAttempt(
    identity: LeaseIdentity,
    attemptId: string,
    copiedCheckpointId: string | null,
  ): Promise<ActivateCheckpointAttemptResult> {
    return this.db.transaction(async (tx) => {
      const authorization = await this.lockAuthorizedRun(tx, identity)
      if (authorization.status !== 'authorized') return authorization

      const [attempt] = await tx
        .select()
        .from(checkpointAttempts)
        .where(
          and(
            eq(checkpointAttempts.id, attemptId),
            eq(checkpointAttempts.jobId, identity.jobId),
            eq(checkpointAttempts.runId, identity.runId),
          ),
        )
        .limit(1)
      if (!attempt) return { status: 'not_found' as const }
      const expectedForkId = attempt.forkedFromCheckpointId
      if (expectedForkId !== copiedCheckpointId) return { status: 'invalid_fork' as const }
      if (attempt.status === 'active') {
        return attempt.latestCheckpointId === copiedCheckpointId
          ? { status: 'replayed' as const, attempt }
          : { status: 'invalid_fork' as const }
      }
      if (attempt.status !== 'preparing') return { status: 'lease_lost' as const }

      const activatedAt = sql<Date>`clock_timestamp()`
      await tx
        .update(checkpointAttempts)
        .set({ status: 'superseded', updatedAt: activatedAt })
        .where(
          and(
            eq(checkpointAttempts.jobId, identity.jobId),
            eq(checkpointAttempts.status, 'active'),
          ),
        )

      const [activated] = await tx
        .update(checkpointAttempts)
        .set({
          status: 'active',
          latestCheckpointId: copiedCheckpointId,
          activatedAt,
          updatedAt: activatedAt,
        })
        .where(
          and(
            eq(checkpointAttempts.id, attempt.id),
            eq(checkpointAttempts.status, 'preparing'),
          ),
        )
        .returning()
      if (!activated) return { status: 'lease_lost' as const }
      return { status: 'activated' as const, attempt: activated }
    })
  }

  async authorizeCheckpointWrite(
    identity: LeaseIdentity,
    storageThreadId: string,
  ): Promise<CheckpointAuthorizationResult> {
    return this.db.transaction(async (tx) => {
      const authorization = await this.lockAuthorizedRun(tx, identity)
      if (authorization.status !== 'authorized') return authorization.status
      const [attempt] = await tx
        .select({ id: checkpointAttempts.id })
        .from(checkpointAttempts)
        .where(
          and(
            eq(checkpointAttempts.jobId, identity.jobId),
            eq(checkpointAttempts.runId, identity.runId),
            eq(checkpointAttempts.checkpointThreadId, storageThreadId),
            eq(checkpointAttempts.status, 'active'),
          ),
        )
        .limit(1)
      return attempt ? 'authorized' : 'not_active'
    })
  }

  async advanceCheckpointPointer(
    identity: LeaseIdentity,
    storageThreadId: string,
    checkpointNamespace: string,
    checkpointIdInput: string,
  ): Promise<AdvanceCheckpointPointerResult> {
    if (checkpointNamespace !== ROOT_CHECKPOINT_NAMESPACE) {
      throw new Error('Only the root checkpoint namespace can advance the business pointer')
    }
    const checkpointId = requireCheckpointId(checkpointIdInput)

    return this.db.transaction(async (tx) => {
      const authorization = await this.lockAuthorizedRun(tx, identity)
      if (authorization.status !== 'authorized') return authorization
      const [attempt] = await tx
        .select()
        .from(checkpointAttempts)
        .where(
          and(
            eq(checkpointAttempts.jobId, identity.jobId),
            eq(checkpointAttempts.runId, identity.runId),
            eq(checkpointAttempts.checkpointThreadId, storageThreadId),
            eq(checkpointAttempts.status, 'active'),
          ),
        )
        .limit(1)
      if (!attempt) return { status: 'not_active' as const }
      if (attempt.latestCheckpointId === checkpointId) {
        return { status: 'replayed' as const, attempt }
      }
      if (attempt.latestCheckpointId && checkpointId < attempt.latestCheckpointId) {
        return { status: 'stale_checkpoint' as const }
      }

      const [advanced] = await tx
        .update(checkpointAttempts)
        .set({ latestCheckpointId: checkpointId, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(checkpointAttempts.id, attempt.id),
            eq(checkpointAttempts.status, 'active'),
          ),
        )
        .returning()
      if (!advanced) return { status: 'not_active' as const }
      return { status: 'advanced' as const, attempt: advanced }
    })
  }

  async getCheckpointAttempt(runId: string) {
    const [attempt] = await this.db
      .select()
      .from(checkpointAttempts)
      .where(eq(checkpointAttempts.runId, runId))
      .limit(1)
    return attempt ?? null
  }

  private async lockAuthorizedRun(
    tx: Parameters<Parameters<VibeDatabase<TQueryResult>['transaction']>[0]>[0],
    identity: LeaseIdentity,
  ): Promise<
    | { status: 'authorized'; graphVersion: string }
    | { status: 'cancel_requested' | 'lease_lost' }
  > {
    const [job] = await tx
      .select({ id: jobs.id, cancelRequestedAt: jobs.cancelRequestedAt })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, identity.jobId),
          eq(jobs.status, 'running'),
          eq(jobs.leaseToken, identity.leaseToken),
        ),
      )
      .for('update')
      .limit(1)
    if (!job) return { status: 'lease_lost' }
    const [activeLease] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, identity.jobId),
          eq(jobs.leaseToken, identity.leaseToken),
          gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(1)
    if (!activeLease) return { status: 'lease_lost' }
    if (job.cancelRequestedAt) return { status: 'cancel_requested' }

    const [run] = await tx
      .select({ graphVersion: runs.graphVersion })
      .from(runs)
      .where(
        and(
          eq(runs.id, identity.runId),
          eq(runs.jobId, identity.jobId),
          eq(runs.status, 'running'),
          eq(runs.leaseToken, identity.leaseToken),
        ),
      )
      .limit(1)
    if (!run) return { status: 'lease_lost' }
    return { status: 'authorized', graphVersion: run.graphVersion }
  }
}

export function createCheckpointRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new CheckpointRepository(db)
}
