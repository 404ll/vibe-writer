import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNotNull, lte, or, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { outboxEvents, type OutboxEventRow } from '../schema'
import type { VibeDatabase } from './jobs'

const MAX_DISPATCHER_ID_LENGTH = 256
const MAX_ERROR_LENGTH = 1_000

export type ClaimedOutboxEvent = OutboxEventRow & {
  status: 'publishing'
  lockedBy: string
  lockToken: string
  lockedAt: Date
}

export type ClaimOutboxBatchInput = {
  dispatcherId: string
  aggregateType: string
  limit: number
  lockTimeoutMs: number
}

export type OutboxLockIdentity = {
  eventId: string
  lockToken: string
}

export type ReleaseOutboxFailureInput = OutboxLockIdentity & {
  error: string
  retryAt: Date
  terminal: boolean
}

function requireDispatcherId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_DISPATCHER_ID_LENGTH) {
    throw new Error(`dispatcherId must contain 1-${MAX_DISPATCHER_ID_LENGTH} characters`)
  }
  return normalized
}

function requirePositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

export class OutboxRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async claimBatch(input: ClaimOutboxBatchInput): Promise<ClaimedOutboxEvent[]> {
    const dispatcherId = requireDispatcherId(input.dispatcherId)
    const aggregateType = requireDispatcherId(input.aggregateType)
    requirePositiveInteger(input.limit, 'limit')
    requirePositiveInteger(input.lockTimeoutMs, 'lockTimeoutMs')

    // `SKIP LOCKED` 让多个调度器可并行领取不同事件；发布超时的记录
    // 会重新进入候选集，因此发布语义是“至少一次”，而不是“恰好一次”。
    return this.db.transaction(async (tx) => {
      const staleBefore = sql<Date>`clock_timestamp() - (${input.lockTimeoutMs} * interval '1 millisecond')`
      const candidates = await tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateType, aggregateType),
            or(
              and(
                eq(outboxEvents.status, 'pending'),
                lte(outboxEvents.availableAt, sql`clock_timestamp()`),
              ),
              and(
                eq(outboxEvents.status, 'publishing'),
                isNotNull(outboxEvents.lockedAt),
                lte(outboxEvents.lockedAt, staleBefore),
              ),
            ),
          ),
        )
        .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.createdAt))
        .limit(input.limit)
        .for('update', { skipLocked: true })

      const claimed: ClaimedOutboxEvent[] = []
      for (const candidate of candidates) {
        const lockToken = randomUUID()
        const [updated] = await tx
          .update(outboxEvents)
          .set({
            status: 'publishing',
            attempts: sql`${outboxEvents.attempts} + 1`,
            lockedBy: dispatcherId,
            lockToken,
            lockedAt: sql`clock_timestamp()`,
            lastError: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(outboxEvents.id, candidate.id))
          .returning()
        if (!updated || !updated.lockedBy || !updated.lockToken || !updated.lockedAt) {
          throw new Error(`Outbox claim failed for ${candidate.id}`)
        }
        claimed.push(updated as ClaimedOutboxEvent)
      }
      return claimed
    })
  }

  async markPublished(identity: OutboxLockIdentity): Promise<'published' | 'lease_lost'> {
    const [updated] = await this.db
      .update(outboxEvents)
      .set({
        status: 'published',
        publishedAt: sql`clock_timestamp()`,
        lockedBy: null,
        lockToken: null,
        lockedAt: null,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(outboxEvents.id, identity.eventId),
          eq(outboxEvents.status, 'publishing'),
          eq(outboxEvents.lockToken, identity.lockToken),
        ),
      )
      .returning({ id: outboxEvents.id })
    return updated ? 'published' : 'lease_lost'
  }

  async releaseFailure(
    input: ReleaseOutboxFailureInput,
  ): Promise<'released' | 'lease_lost'> {
    if (!(input.retryAt instanceof Date) || Number.isNaN(input.retryAt.getTime())) {
      throw new Error('retryAt must be a valid Date')
    }
    const error = input.error.trim().slice(0, MAX_ERROR_LENGTH) || 'Outbox publish failed.'
    const [updated] = await this.db
      .update(outboxEvents)
      .set({
        status: input.terminal ? 'failed' : 'pending',
        availableAt: input.retryAt,
        publishedAt: null,
        lockedBy: null,
        lockToken: null,
        lockedAt: null,
        lastError: error,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(outboxEvents.id, input.eventId),
          eq(outboxEvents.status, 'publishing'),
          eq(outboxEvents.lockToken, input.lockToken),
        ),
      )
      .returning({ id: outboxEvents.id })
    return updated ? 'released' : 'lease_lost'
  }
}

export function createOutboxRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new OutboxRepository(db)
}
