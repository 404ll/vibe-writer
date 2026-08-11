import { createHash } from 'node:crypto'
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { MemorySourceSignalKind, MemorySubjectKind } from '../domain'
import {
  jobs,
  memorySourceSignals,
  memorySourceSignalTombstones,
  outboxEvents,
  runs,
  workspaces,
} from '../schema'
import type { VibeDatabase } from './jobs'
import { settleSignalExtractionErasure } from './memory-extractions'
import {
  requireWorkspaceEditor,
  setWorkspaceSession,
  WorkspacePermissionError,
  type AuthorizedWorkspaceScope,
} from './workspaces'

export type CreateMemorySourceSignalInput = {
  idempotencyKey: string
  sourceKind: MemorySourceSignalKind
  subject: { kind: MemorySubjectKind; key: string }
  text: string
  consentPolicyVersion: string
  retentionDays: number
  sourceRunId?: string
}

export type DeleteMemorySourceSignalInput = {
  sourceSignalId: string
  reasonCode: string
}

export type MemorySourceSignalPageInput = {
  limit: number
  cursor?: { id: string }
}

export class MemorySourceSignalConflictError extends Error {
  readonly name = 'MemorySourceSignalConflictError'
}

export class MemorySourceSignalNotFoundError extends Error {
  readonly name = 'MemorySourceSignalNotFoundError'
}

function bounded(value: string, name: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} non-whitespace characters`)
  }
  return normalized
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function databaseDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Database returned an invalid timestamp')
  return date
}

function validatePage(input: MemorySourceSignalPageInput): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error('Memory source signal page limit must be an integer between 1 and 100')
  }
}

function signalExtractionOutbox(sourceSignalId: string) {
  return {
    idempotencyKey: `signal:${sourceSignalId}:memory-extraction:v2`,
    aggregateType: 'memory_extraction',
    aggregateId: sourceSignalId,
    eventType: 'memory.extraction.requested',
    payload: {
      schemaVersion: 2,
      source: { kind: 'signal', signalId: sourceSignalId },
    },
  }
}

function authorizeSubject(
  scope: AuthorizedWorkspaceScope,
  subject: { kind: MemorySubjectKind; key: string },
): void {
  if (subject.kind === 'principal') {
    if (subject.key !== scope.principalId) {
      throw new WorkspacePermissionError('A user-authored principal signal must target its author')
    }
    return
  }
  requireWorkspaceEditor(scope)
}

export class MemorySourceSignalRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async create(
    scope: AuthorizedWorkspaceScope,
    input: CreateMemorySourceSignalInput,
  ) {
    const idempotencyKey = bounded(input.idempotencyKey, 'idempotencyKey', 256)
    const text = bounded(input.text, 'text', 20_000)
    const consentPolicyVersion = bounded(
      input.consentPolicyVersion,
      'consentPolicyVersion',
      256,
    )
    const subject = {
      kind: input.subject.kind,
      key: bounded(input.subject.key, 'subject.key', 256),
    }
    authorizeSubject(scope, subject)
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 365) {
      throw new Error('retentionDays must be an integer between 1 and 365')
    }
    const requestFingerprint = fingerprint({
      workspaceId: scope.workspaceId,
      createdByPrincipalId: scope.principalId,
      sourceRunId: input.sourceRunId ?? null,
      sourceKind: input.sourceKind,
      subject,
      text,
      consentPolicyVersion,
      retentionDays: input.retentionDays,
    })
    const evidenceFingerprint = fingerprint({
      author: scope.principalId,
      scope: 'durable',
      sourceKind: input.sourceKind,
      subject,
      text,
    })

    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      if (input.sourceRunId) {
        const [source] = await scoped
          .select({ runId: runs.id })
          .from(runs)
          .innerJoin(jobs, eq(jobs.id, runs.jobId))
          .where(and(
            eq(runs.id, input.sourceRunId),
            eq(jobs.workspaceId, scope.workspaceId),
            eq(jobs.createdByPrincipalId, scope.principalId),
          ))
          .limit(1)
        if (!source) {
          throw new MemorySourceSignalNotFoundError(
            'Memory source run was not found for the signal author',
          )
        }
      }
      const [clock] = await scoped
        .select({ databaseNow: sql<Date | string>`clock_timestamp()` })
        .from(workspaces)
        .where(eq(workspaces.id, scope.workspaceId))
        .limit(1)
      if (!clock) throw new Error('Memory source signal workspace was not found')
      const retentionUntil = new Date(
        databaseDate(clock.databaseNow).getTime() + input.retentionDays * 86_400_000,
      )
      const [created] = await scoped
        .insert(memorySourceSignals)
        .values({
          workspaceId: scope.workspaceId,
          createdByPrincipalId: scope.principalId,
          sourceRunId: input.sourceRunId ?? null,
          idempotencyKey,
          requestFingerprint,
          sourceKind: input.sourceKind,
          subjectKind: subject.kind,
          subjectKey: subject.key,
          sourceText: text,
          evidenceFingerprint,
          consentBasis: 'explicit_user',
          consentPolicyVersion,
          retentionUntil,
        })
        .onConflictDoNothing({
          target: [
            memorySourceSignals.workspaceId,
            memorySourceSignals.createdByPrincipalId,
            memorySourceSignals.idempotencyKey,
          ],
        })
        .returning()
      let signal = created
      if (!signal) {
        ;[signal] = await scoped
          .select()
          .from(memorySourceSignals)
          .where(and(
            eq(memorySourceSignals.workspaceId, scope.workspaceId),
            eq(memorySourceSignals.createdByPrincipalId, scope.principalId),
            eq(memorySourceSignals.idempotencyKey, idempotencyKey),
          ))
          .limit(1)
        if (!signal) throw new Error('Memory source signal idempotency replay was not found')
        if (signal.requestFingerprint !== requestFingerprint) {
          throw new MemorySourceSignalConflictError(
            'Memory source signal idempotency collision',
          )
        }
      }
      await scoped.insert(outboxEvents)
        .values(signalExtractionOutbox(signal.id))
        .onConflictDoNothing({ target: outboxEvents.idempotencyKey })
      return { signal, created: Boolean(created) }
    })
  }

  async listOwn(scope: AuthorizedWorkspaceScope) {
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      return scoped
        .select()
        .from(memorySourceSignals)
        .where(and(
          eq(memorySourceSignals.workspaceId, scope.workspaceId),
          eq(memorySourceSignals.createdByPrincipalId, scope.principalId),
          sql`${memorySourceSignals.retentionUntil} > clock_timestamp()`,
        ))
        .orderBy(asc(memorySourceSignals.createdAt), asc(memorySourceSignals.id))
    })
  }

  async listOwnPage(
    scope: AuthorizedWorkspaceScope,
    input: MemorySourceSignalPageInput,
  ) {
    validatePage(input)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const rows = await scoped
        .select()
        .from(memorySourceSignals)
        .where(and(
          eq(memorySourceSignals.workspaceId, scope.workspaceId),
          eq(memorySourceSignals.createdByPrincipalId, scope.principalId),
          sql`${memorySourceSignals.retentionUntil} > clock_timestamp()`,
          input.cursor ? gt(memorySourceSignals.id, input.cursor.id) : undefined,
        ))
        .orderBy(asc(memorySourceSignals.id))
        .limit(input.limit + 1)
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        nextCursor: rows.length > input.limit && last ? { id: last.id } : null,
      }
    })
  }

  async delete(
    scope: AuthorizedWorkspaceScope,
    input: DeleteMemorySourceSignalInput,
  ) {
    const reasonCode = bounded(input.reasonCode, 'reasonCode', 256)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [signal] = await scoped
        .select()
        .from(memorySourceSignals)
        .where(and(
          eq(memorySourceSignals.id, input.sourceSignalId),
          eq(memorySourceSignals.workspaceId, scope.workspaceId),
        ))
        .for('update')
        .limit(1)
      if (!signal) {
        const [tombstone] = await scoped
          .select()
          .from(memorySourceSignalTombstones)
          .where(and(
            eq(memorySourceSignalTombstones.sourceSignalId, input.sourceSignalId),
            eq(memorySourceSignalTombstones.workspaceId, scope.workspaceId),
          ))
          .limit(1)
        if (
          tombstone &&
          tombstone.deletedByPrincipalId === scope.principalId &&
          tombstone.reasonCode === reasonCode
        ) {
          return { status: 'deleted' as const, tombstone, replayed: true }
        }
        throw new MemorySourceSignalNotFoundError(
          'Memory source signal not found in workspace',
        )
      }
      if (signal.createdByPrincipalId !== scope.principalId && scope.role !== 'owner') {
        throw new WorkspacePermissionError('Only the signal author or workspace owner can delete it')
      }
      const [tombstone] = await scoped
        .insert(memorySourceSignalTombstones)
        .values({
          sourceSignalId: signal.id,
          workspaceId: signal.workspaceId,
          deletedByPrincipalId: scope.principalId,
          reasonCode,
        })
        .returning()
      if (!tombstone) throw new Error('Memory source signal tombstone was not created')
      await settleSignalExtractionErasure(scoped, signal.id)
      await scoped
        .update(outboxEvents)
        .set({
          status: 'failed',
          lockedBy: null,
          lockToken: null,
          lockedAt: null,
          publishedAt: null,
          lastError: 'Memory extraction source was erased.',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(
          eq(outboxEvents.aggregateType, 'memory_extraction'),
          eq(outboxEvents.aggregateId, signal.id),
          inArray(outboxEvents.status, ['pending', 'publishing']),
        ))
      await scoped.delete(memorySourceSignals).where(eq(memorySourceSignals.id, signal.id))
      return { status: 'deleted' as const, tombstone, replayed: false }
    })
  }

  async expireDue(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Memory source signal expiry limit must be an integer between 1 and 1000')
    }
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(memorySourceSignals)
        .where(lte(memorySourceSignals.retentionUntil, sql`clock_timestamp()`))
        .orderBy(asc(memorySourceSignals.retentionUntil), asc(memorySourceSignals.id))
        .limit(limit)
        .for('update', { skipLocked: true })
      if (due.length > 0) {
        await tx.insert(memorySourceSignalTombstones).values(due.map((signal) => ({
          sourceSignalId: signal.id,
          workspaceId: signal.workspaceId,
          deletedByPrincipalId: null,
          reasonCode: 'retention_elapsed',
        }))).onConflictDoNothing({ target: memorySourceSignalTombstones.sourceSignalId })
        for (const signal of due) {
          const scoped = tx as unknown as VibeDatabase<TQueryResult>
          await settleSignalExtractionErasure(scoped, signal.id)
          await scoped
            .update(outboxEvents)
            .set({
              status: 'failed',
              lockedBy: null,
              lockToken: null,
              lockedAt: null,
              publishedAt: null,
              lastError: 'Memory extraction source retention elapsed.',
              updatedAt: sql`clock_timestamp()`,
            })
            .where(and(
              eq(outboxEvents.aggregateType, 'memory_extraction'),
              eq(outboxEvents.aggregateId, signal.id),
              inArray(outboxEvents.status, ['pending', 'publishing']),
            ))
          await scoped.delete(memorySourceSignals).where(eq(memorySourceSignals.id, signal.id))
        }
      }
      return { signalsDeleted: due.length }
    })
  }

  async inspectExpiryBacklog(alertThreshold = 1_000) {
    if (!Number.isInteger(alertThreshold) || alertThreshold < 1 || alertThreshold > 10_000) {
      throw new Error(
        'Memory source signal expiry alert threshold must be an integer between 1 and 10000',
      )
    }
    const due = await this.db
      .select({ id: memorySourceSignals.id })
      .from(memorySourceSignals)
      .where(lte(memorySourceSignals.retentionUntil, sql`clock_timestamp()`))
      .orderBy(asc(memorySourceSignals.retentionUntil), asc(memorySourceSignals.id))
      .limit(alertThreshold)
    return {
      signalsDue: due.length,
      signalsCapped: due.length === alertThreshold,
    }
  }
}

export function createMemorySourceSignalRepository<
  TQueryResult extends PgQueryResultHKT,
>(db: VibeDatabase<TQueryResult>) {
  return new MemorySourceSignalRepository(db)
}
