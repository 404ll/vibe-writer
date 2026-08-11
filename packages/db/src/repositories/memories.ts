import { createHash } from 'node:crypto'
import {
  MEMORY_POLICY,
  MemoryProposalSchema,
  evaluateMemoryProposal,
  planMemoryReviewTransition,
  type MemoryProposal,
} from '@vibe-writer/memory-core'
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  jobs,
  articles,
  articleVersions,
  memories,
  memoryCandidateEvents,
  memoryCandidates,
  memoryRevisions,
  memorySourceSignals,
  memoryTombstones,
  runs,
  type MemoryCandidateRow,
  type MemoryRow,
} from '../schema'
import type { VibeDatabase } from './jobs'
import {
  requireWorkspaceEditor,
  requireWorkspaceOwner,
  setWorkspaceSession,
  type AuthorizedWorkspaceScope,
} from './workspaces'

const CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/

function code(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !CODE_PATTERN.test(normalized)) {
    throw new Error(`${name} must be a lowercase machine-readable code`)
  }
  return normalized
}

function databaseDate(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error('Database clock is invalid')
  return parsed
}

function slotWhere(input: {
  workspaceId: string
  subjectKind: MemoryProposal['subject']['kind']
  subjectKey: string
  memoryKey: string
}) {
  return and(
    eq(memories.workspaceId, input.workspaceId),
    eq(memories.subjectKind, input.subjectKind),
    eq(memories.subjectKey, input.subjectKey),
    eq(memories.memoryKey, input.memoryKey),
  )
}

function candidateSlotWhere(input: {
  workspaceId: string
  subjectKind: MemoryProposal['subject']['kind']
  subjectKey: string
  memoryKey: string
}) {
  return and(
    eq(memoryCandidates.workspaceId, input.workspaceId),
    eq(memoryCandidates.subjectKind, input.subjectKind),
    eq(memoryCandidates.subjectKey, input.subjectKey),
    eq(memoryCandidates.memoryKey, input.memoryKey),
  )
}

function slotFingerprint(memory: Pick<
  MemoryRow,
  'workspaceId' | 'subjectKind' | 'subjectKey' | 'memoryKey'
>): string {
  const digest = createHash('sha256')
    .update(memory.workspaceId)
    .update('\0')
    .update(memory.subjectKind)
    .update('\0')
    .update(memory.subjectKey)
    .update('\0')
    .update(memory.memoryKey)
    .digest('hex')
  return `sha256:${digest}`
}

function assertCandidateReplay(
  existing: MemoryCandidateRow,
  values: Omit<typeof memoryCandidates.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>,
): void {
  const same = existing.workspaceId === values.workspaceId &&
    existing.sourceKind === values.sourceKind &&
    existing.sourceRunId === values.sourceRunId &&
    existing.sourceSignalId === values.sourceSignalId &&
    existing.subjectKind === values.subjectKind &&
    existing.subjectKey === values.subjectKey &&
    existing.memoryKey === values.memoryKey &&
    existing.kind === values.kind &&
    existing.content === values.content &&
    existing.contentFingerprint === values.contentFingerprint &&
    existing.proposedBy === values.proposedBy &&
    existing.confidence === values.confidence &&
    existing.sensitivity === values.sensitivity &&
    existing.consentBasis === values.consentBasis &&
    existing.consentPolicyVersion === values.consentPolicyVersion &&
    existing.evidenceFingerprint === values.evidenceFingerprint &&
    existing.extractorKey === values.extractorKey &&
    existing.extractorVersion === values.extractorVersion &&
    existing.policyVersion === values.policyVersion &&
    existing.policyOutcome === values.policyOutcome &&
    existing.expiresAt.getTime() === values.expiresAt?.getTime()
  if (!same) {
    throw new Error(
      `Memory extractor version collision: ${existing.extractorKey}@${existing.extractorVersion}`,
    )
  }
}

export type ReviewMemoryCandidateInput = {
  candidateId: string
  decision: 'materialize' | 'reject'
  reasonCode: string
  replaceMemoryId?: string
}

export type DeleteMemoryInput = {
  memoryId: string
  reasonCode: string
}

export type MemoryManagementPageInput = {
  limit: number
  cursor?: { id: string }
}

function validateManagementPage(input: MemoryManagementPageInput): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error('Memory management page limit must be an integer between 1 and 100')
  }
}

export class MemoryCandidateNotFoundError extends Error {
  readonly name = 'MemoryCandidateNotFoundError'
}

export class MemoryNotFoundError extends Error {
  readonly name = 'MemoryNotFoundError'
}

export class MemoryReviewConflictError extends Error {
  readonly name = 'MemoryReviewConflictError'
}

export class MemoryRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async loadCompletedExtractionSource(sourceRunId: string) {
    const [source] = await this.db
      .select({
        runId: runs.id,
        workspaceId: jobs.workspaceId,
        topic: articles.topic,
        content: sql<string>`coalesce(${articleVersions.content}, ${articles.content})`,
        contentFingerprint: sql<string>`coalesce(${articleVersions.contentFingerprint}, ${articles.contentFingerprint})`,
        retentionAnchor: sql<Date | string>`${runs.finishedAt}`,
      })
      .from(runs)
      .innerJoin(jobs, eq(jobs.id, runs.jobId))
      .innerJoin(articles, and(
        eq(articles.jobId, jobs.id),
        eq(articles.sourceRunId, runs.id),
      ))
      .leftJoin(articleVersions, and(
        eq(articleVersions.articleId, articles.id),
        eq(articleVersions.sourceRevision, 0),
      ))
      .where(and(
        eq(runs.id, sourceRunId),
        eq(runs.status, 'completed'),
        eq(jobs.status, 'completed'),
      ))
      .limit(1)
    return source ?? null
  }

  async submitProposal(proposalInput: unknown) {
    const parsed = MemoryProposalSchema.parse(proposalInput)
    return this.db.transaction(async (tx) => {
      let databaseNow: Date | string
      if (parsed.source.kind === 'run') {
        const [source] = await tx
          .select({
            runStatus: runs.status,
            jobStatus: jobs.status,
            workspaceId: jobs.workspaceId,
            databaseNow: sql<Date | string>`clock_timestamp()`,
          })
          .from(runs)
          .innerJoin(jobs, eq(jobs.id, runs.jobId))
          .where(eq(runs.id, parsed.source.runId))
          .limit(1)
        if (!source || source.workspaceId !== parsed.workspaceId) {
          throw new Error('Completed Memory source run was not found in workspace')
        }
        if (source.runStatus !== 'completed' || source.jobStatus !== 'completed') {
          throw new Error('Only a completed source run can propose durable Memory')
        }
        databaseNow = source.databaseNow
      } else {
        const [source] = await tx
          .select({
            row: memorySourceSignals,
            databaseNow: sql<Date | string>`clock_timestamp()`,
          })
          .from(memorySourceSignals)
          .where(eq(memorySourceSignals.id, parsed.source.signalId))
          .limit(1)
        if (!source || source.row.workspaceId !== parsed.workspaceId) {
          throw new Error('Memory source signal was not found in workspace')
        }
        const now = databaseDate(source.databaseNow)
        if (source.row.retentionUntil <= now) {
          throw new Error('Memory source signal has reached its retention deadline')
        }
        if (
          source.row.evidenceFingerprint !== parsed.source.evidenceFingerprint ||
          source.row.subjectKind !== parsed.subject.kind ||
          source.row.subjectKey !== parsed.subject.key ||
          parsed.consent.basis !== 'explicit_user' ||
          source.row.consentPolicyVersion !== parsed.consent.policyVersion ||
          new Date(parsed.expiresAt) > source.row.retentionUntil
        ) {
          throw new Error('Memory proposal does not match its trusted source signal')
        }
        databaseNow = source.databaseNow
      }

      const [active] = await tx
        .select()
        .from(memories)
        .where(slotWhere({
          workspaceId: parsed.workspaceId,
          subjectKind: parsed.subject.kind,
          subjectKey: parsed.subject.key,
          memoryKey: parsed.memoryKey,
        }))
        .for('update')
        .limit(1)
      const now = databaseDate(databaseNow)
      if (active && active.expiresAt <= now) {
        await tx.insert(memoryTombstones).values({
          memoryId: active.id,
          workspaceId: active.workspaceId,
          slotFingerprint: slotFingerprint(active),
          deletedByPrincipalId: null,
          reasonCode: 'retention_elapsed',
        }).onConflictDoNothing({ target: memoryTombstones.memoryId })
        await tx.delete(memories).where(eq(memories.id, active.id))
        await tx.delete(memoryCandidates)
          .where(eq(memoryCandidates.id, active.currentCandidateId))
      }
      const activeMemory = active && active.expiresAt > now
        ? active
        : undefined
      const decision = evaluateMemoryProposal({
        proposal: parsed,
        now,
        activeMemory: activeMemory
          ? {
              workspaceId: activeMemory.workspaceId,
              subject: {
                kind: activeMemory.subjectKind,
                key: activeMemory.subjectKey,
              },
              memoryKey: activeMemory.memoryKey,
              contentFingerprint: activeMemory.currentContentFingerprint,
            }
          : undefined,
      })
      if (decision.outcome === 'rejected') {
        return { status: 'rejected' as const, reason: decision.reason }
      }
      if (decision.outcome === 'duplicate') {
        return { status: 'duplicate' as const, memory: activeMemory! }
      }
      const proposal = decision.proposal
      const values = {
        workspaceId: proposal.workspaceId,
        sourceKind: proposal.source.kind,
        sourceRunId: proposal.source.kind === 'run' ? proposal.source.runId : null,
        sourceSignalId: proposal.source.kind === 'signal' ? proposal.source.signalId : null,
        subjectKind: proposal.subject.kind,
        subjectKey: proposal.subject.key,
        memoryKey: proposal.memoryKey,
        kind: proposal.kind,
        content: proposal.content,
        contentFingerprint: decision.contentFingerprint,
        proposedBy: proposal.proposedBy,
        confidence: proposal.confidence,
        sensitivity: proposal.sensitivity,
        consentBasis: proposal.consent.basis,
        consentPolicyVersion: proposal.consent.policyVersion,
        evidenceFingerprint: proposal.source.evidenceFingerprint,
        extractorKey: proposal.extractor.key,
        extractorVersion: proposal.extractor.version,
        policyVersion: MEMORY_POLICY.version,
        policyOutcome: decision.outcome,
        status: 'pending_review' as const,
        expiresAt: new Date(proposal.expiresAt),
        reviewedByPrincipalId: null,
        reviewedAt: null,
        decisionReasonCode: null,
        materializedMemoryId: null,
        materializedRevision: null,
        nextEventSeq: 1,
      }
      const [created] = await tx
        .insert(memoryCandidates)
        .values(values)
        .onConflictDoNothing()
        .returning()
      if (!created) {
        const sourceWhere = proposal.source.kind === 'run'
          ? and(
              eq(memoryCandidates.sourceKind, 'run'),
              eq(memoryCandidates.sourceRunId, proposal.source.runId),
            )
          : and(
              eq(memoryCandidates.sourceKind, 'signal'),
              eq(memoryCandidates.sourceSignalId, proposal.source.signalId),
            )
        const [existing] = await tx
          .select()
          .from(memoryCandidates)
          .where(and(
            sourceWhere,
            eq(memoryCandidates.extractorKey, proposal.extractor.key),
            eq(memoryCandidates.extractorVersion, proposal.extractor.version),
            eq(memoryCandidates.subjectKind, proposal.subject.kind),
            eq(memoryCandidates.subjectKey, proposal.subject.key),
            eq(memoryCandidates.memoryKey, proposal.memoryKey),
          ))
          .limit(1)
        if (!existing) throw new Error('Memory candidate idempotent lookup failed')
        assertCandidateReplay(existing, values)
        return { status: decision.outcome, candidate: existing, created: false }
      }
      await tx.insert(memoryCandidateEvents).values({
        candidateId: created.id,
        seq: 0,
        eventType: 'proposed',
        actorPrincipalId: null,
        reasonCode: decision.outcome === 'conflict'
          ? 'policy_conflict_detected'
          : 'policy_candidate_created',
      })
      return { status: decision.outcome, candidate: created, created: true }
    })
  }

  async listMemories(scope: AuthorizedWorkspaceScope) {
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      return scoped
        .select({ memory: memories, revision: memoryRevisions })
        .from(memories)
        .innerJoin(memoryRevisions, and(
          eq(memoryRevisions.memoryId, memories.id),
          eq(memoryRevisions.revision, memories.currentRevision),
        ))
        .where(and(
          eq(memories.workspaceId, scope.workspaceId),
          gt(memories.expiresAt, sql`clock_timestamp()`),
        ))
        .orderBy(asc(memories.subjectKind), asc(memories.subjectKey), asc(memories.memoryKey))
    })
  }

  async listMemoriesPage(
    scope: AuthorizedWorkspaceScope,
    input: MemoryManagementPageInput,
  ) {
    validateManagementPage(input)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const rows = await scoped
        .select({ memory: memories, revision: memoryRevisions })
        .from(memories)
        .innerJoin(memoryRevisions, and(
          eq(memoryRevisions.memoryId, memories.id),
          eq(memoryRevisions.revision, memories.currentRevision),
        ))
        .where(and(
          eq(memories.workspaceId, scope.workspaceId),
          gt(memories.expiresAt, sql`clock_timestamp()`),
          input.cursor ? gt(memories.id, input.cursor.id) : undefined,
        ))
        .orderBy(asc(memories.id))
        .limit(input.limit + 1)
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)?.memory
      return {
        items,
        nextCursor: rows.length > input.limit && last
          ? { id: last.id }
          : null,
      }
    })
  }

  async listCandidates(scope: AuthorizedWorkspaceScope) {
    requireWorkspaceEditor(scope)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      return scoped
        .select()
        .from(memoryCandidates)
        .where(eq(memoryCandidates.workspaceId, scope.workspaceId))
        .orderBy(asc(memoryCandidates.createdAt), asc(memoryCandidates.id))
    })
  }

  async listCandidatesPage(
    scope: AuthorizedWorkspaceScope,
    input: MemoryManagementPageInput,
  ) {
    requireWorkspaceEditor(scope)
    validateManagementPage(input)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const rows = await scoped
        .select()
        .from(memoryCandidates)
        .where(and(
          eq(memoryCandidates.workspaceId, scope.workspaceId),
          input.cursor ? gt(memoryCandidates.id, input.cursor.id) : undefined,
        ))
        .orderBy(asc(memoryCandidates.id))
        .limit(input.limit + 1)
      const items = rows.slice(0, input.limit)
      const last = items.at(-1)
      return {
        items,
        nextCursor: rows.length > input.limit && last
          ? { id: last.id }
          : null,
      }
    })
  }

  async listCandidateEvents(scope: AuthorizedWorkspaceScope, candidateId: string) {
    requireWorkspaceEditor(scope)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const events = await scoped
        .select({ event: memoryCandidateEvents })
        .from(memoryCandidateEvents)
        .innerJoin(memoryCandidates, eq(memoryCandidates.id, memoryCandidateEvents.candidateId))
        .where(and(
          eq(memoryCandidateEvents.candidateId, candidateId),
          eq(memoryCandidates.workspaceId, scope.workspaceId),
        ))
        .orderBy(asc(memoryCandidateEvents.seq))
        .then((rows) => rows.map(({ event }) => event))
      if (events.length === 0) {
        throw new MemoryCandidateNotFoundError('Memory candidate not found in workspace')
      }
      return events
    })
  }

  async reviewCandidate(
    scope: AuthorizedWorkspaceScope,
    input: ReviewMemoryCandidateInput,
  ) {
    requireWorkspaceEditor(scope)
    const reasonCode = code(input.reasonCode, 'reasonCode')
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [selected] = await scoped
        .select({
          row: memoryCandidates,
          databaseNow: sql<Date | string>`clock_timestamp()`,
        })
        .from(memoryCandidates)
        .where(and(
          eq(memoryCandidates.id, input.candidateId),
          eq(memoryCandidates.workspaceId, scope.workspaceId),
        ))
        .for('update')
        .limit(1)
      if (!selected) {
        throw new MemoryCandidateNotFoundError('Memory candidate not found in workspace')
      }
      const candidate = selected.row
      const now = databaseDate(selected.databaseNow)
      if (candidate.expiresAt <= now) {
        await scoped.delete(memoryCandidates).where(eq(memoryCandidates.id, candidate.id))
        return { status: 'expired' as const, candidateId: candidate.id }
      }

      const targetStatus = input.decision === 'reject' ? 'rejected' : 'materialized'
      if (candidate.status === targetStatus) {
        const sameReplacement = targetStatus === 'rejected'
          ? input.replaceMemoryId === undefined
          : candidate.policyOutcome === 'candidate'
            ? input.replaceMemoryId === undefined
            : input.replaceMemoryId === candidate.materializedMemoryId
        if (
          candidate.reviewedByPrincipalId !== scope.principalId ||
          candidate.decisionReasonCode !== reasonCode ||
          !sameReplacement
        ) {
          throw new MemoryReviewConflictError('Memory candidate review collision')
        }
        if (targetStatus === 'materialized') {
          const [memory] = await scoped
            .select()
            .from(memories)
            .where(and(
              eq(memories.id, candidate.materializedMemoryId!),
              eq(memories.workspaceId, scope.workspaceId),
            ))
            .limit(1)
          if (!memory) throw new Error('Materialized Memory replay target was not found')
          return { status: 'materialized' as const, candidate, memory, replayed: true }
        }
        return { status: 'rejected' as const, candidate, replayed: true }
      }
      if (candidate.status !== 'pending_review') {
        throw new MemoryReviewConflictError(
          `Memory candidate is already ${candidate.status}`,
        )
      }

      const eventSeq = candidate.nextEventSeq
      if (input.decision === 'reject') {
        if (input.replaceMemoryId !== undefined) {
          throw new Error('replaceMemoryId is only valid for conflict materialization')
        }
        const [rejected] = await scoped
          .update(memoryCandidates)
          .set({
            status: 'rejected',
            reviewedByPrincipalId: scope.principalId,
            reviewedAt: sql`clock_timestamp()`,
            decisionReasonCode: reasonCode,
            nextEventSeq: eventSeq + 1,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(memoryCandidates.id, candidate.id))
          .returning()
        if (!rejected) throw new Error('Memory candidate rejection lost its row lock')
        await scoped.insert(memoryCandidateEvents).values({
          candidateId: candidate.id,
          seq: eventSeq,
          eventType: 'rejected',
          actorPrincipalId: scope.principalId,
          reasonCode,
        })
        return { status: 'rejected' as const, candidate: rejected, replayed: false }
      }

      const [active] = await scoped
        .select()
        .from(memories)
        .where(slotWhere({
          workspaceId: scope.workspaceId,
          subjectKind: candidate.subjectKind,
          subjectKey: candidate.subjectKey,
          memoryKey: candidate.memoryKey,
        }))
        .for('update')
        .limit(1)
      if (active && active.expiresAt <= now) {
        await scoped.insert(memoryTombstones).values({
          memoryId: active.id,
          workspaceId: active.workspaceId,
          slotFingerprint: slotFingerprint(active),
          deletedByPrincipalId: null,
          reasonCode: 'retention_elapsed',
        }).onConflictDoNothing({ target: memoryTombstones.memoryId })
        await scoped.delete(memories).where(eq(memories.id, active.id))
        await scoped.delete(memoryCandidates)
          .where(eq(memoryCandidates.id, active.currentCandidateId))
      }
      const current = active && active.expiresAt > now ? active : undefined
      const transition = planMemoryReviewTransition({
        candidate: {
          policyOutcome: candidate.policyOutcome,
          kind: candidate.kind,
          contentFingerprint: candidate.contentFingerprint,
        },
        ...(current
          ? {
              activeMemory: {
                id: current.id,
                kind: current.kind,
                currentRevision: current.currentRevision,
              },
            }
          : {}),
        ...(input.replaceMemoryId ? { replaceMemoryId: input.replaceMemoryId } : {}),
      })
      if (transition.outcome === 'rejected') {
        const messages = {
          stale_candidate: 'Memory candidate is stale because the slot is now occupied',
          unexpected_replacement: 'A new Memory candidate cannot replace an existing Memory',
          replacement_required: 'Conflict materialization requires the current Memory id',
          kind_mismatch: 'A Memory conflict cannot change the slot kind',
        } as const
        throw new MemoryReviewConflictError(messages[transition.reason])
      }

      let materialized: MemoryRow
      let revision: number
      if (transition.outcome === 'create') {
        const [created] = await scoped
          .insert(memories)
          .values({
            workspaceId: candidate.workspaceId,
            subjectKind: candidate.subjectKind,
            subjectKey: candidate.subjectKey,
            memoryKey: candidate.memoryKey,
            kind: candidate.kind,
            currentRevision: 1,
            currentContentFingerprint: candidate.contentFingerprint,
            currentCandidateId: candidate.id,
            expiresAt: candidate.expiresAt,
          })
          .returning()
        if (!created) throw new Error('Memory materialization did not create a row')
        materialized = created
        revision = 1
      } else {
        revision = transition.revision
        const [updated] = await scoped
          .update(memories)
          .set({
            currentRevision: revision,
            currentContentFingerprint: candidate.contentFingerprint,
            currentCandidateId: candidate.id,
            expiresAt: candidate.expiresAt,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(
            eq(memories.id, transition.memoryId),
            eq(memories.currentRevision, current!.currentRevision),
          ))
          .returning()
        if (!updated) {
          throw new MemoryReviewConflictError('Memory revision compare-and-swap failed')
        }
        materialized = updated
      }
      await scoped.insert(memoryRevisions).values({
        memoryId: materialized.id,
        revision,
        content: candidate.content,
        contentFingerprint: candidate.contentFingerprint,
        sourceCandidateId: candidate.id,
        createdByPrincipalId: scope.principalId,
      })
      const [reviewed] = await scoped
        .update(memoryCandidates)
        .set({
          status: 'materialized',
          reviewedByPrincipalId: scope.principalId,
          reviewedAt: sql`clock_timestamp()`,
          decisionReasonCode: reasonCode,
          materializedMemoryId: materialized.id,
          materializedRevision: revision,
          nextEventSeq: eventSeq + 1,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryCandidates.id, candidate.id))
        .returning()
      if (!reviewed) throw new Error('Memory materialization lost its candidate row')
      await scoped.insert(memoryCandidateEvents).values({
        candidateId: candidate.id,
        seq: eventSeq,
        eventType: 'materialized',
        actorPrincipalId: scope.principalId,
        reasonCode,
      })
      return {
        status: 'materialized' as const,
        candidate: reviewed,
        memory: materialized,
        replayed: false,
      }
    })
  }

  async deleteMemory(scope: AuthorizedWorkspaceScope, input: DeleteMemoryInput) {
    requireWorkspaceOwner(scope)
    const reasonCode = code(input.reasonCode, 'reasonCode')
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [memory] = await scoped
        .select()
        .from(memories)
        .where(and(eq(memories.id, input.memoryId), eq(memories.workspaceId, scope.workspaceId)))
        .for('update')
        .limit(1)
      if (!memory) {
        const [tombstone] = await scoped
          .select()
          .from(memoryTombstones)
          .where(and(
            eq(memoryTombstones.memoryId, input.memoryId),
            eq(memoryTombstones.workspaceId, scope.workspaceId),
          ))
          .limit(1)
        if (
          tombstone && tombstone.deletedByPrincipalId === scope.principalId &&
          tombstone.reasonCode === reasonCode
        ) {
          return { status: 'deleted' as const, tombstone, replayed: true }
        }
        throw new MemoryNotFoundError('Memory not found in workspace')
      }
      const [tombstone] = await scoped
        .insert(memoryTombstones)
        .values({
          memoryId: memory.id,
          workspaceId: memory.workspaceId,
          slotFingerprint: slotFingerprint(memory),
          deletedByPrincipalId: scope.principalId,
          reasonCode,
        })
        .returning()
      if (!tombstone) throw new Error('Memory tombstone was not created')
      await scoped.delete(memories).where(eq(memories.id, memory.id))
      await scoped.delete(memoryCandidates).where(candidateSlotWhere(memory))
      return { status: 'deleted' as const, tombstone, replayed: false }
    })
  }

  async expireDue(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Memory expiry limit must be an integer between 1 and 1000')
    }
    return this.db.transaction(async (tx) => {
      const dueMemories = await tx
        .select()
        .from(memories)
        .where(lte(memories.expiresAt, sql`clock_timestamp()`))
        .orderBy(asc(memories.expiresAt), asc(memories.id))
        .limit(limit)
        .for('update', { skipLocked: true })
      if (dueMemories.length > 0) {
        await tx.insert(memoryTombstones).values(dueMemories.map((memory) => ({
          memoryId: memory.id,
          workspaceId: memory.workspaceId,
          slotFingerprint: slotFingerprint(memory),
          deletedByPrincipalId: null,
          reasonCode: 'retention_elapsed',
        }))).onConflictDoNothing({ target: memoryTombstones.memoryId })
        await tx.delete(memories).where(inArray(memories.id, dueMemories.map(({ id }) => id)))
      }
      const dueCandidates = await tx
        .select({ id: memoryCandidates.id })
        .from(memoryCandidates)
        .where(lte(memoryCandidates.expiresAt, sql`clock_timestamp()`))
        .orderBy(asc(memoryCandidates.expiresAt), asc(memoryCandidates.id))
        .limit(limit)
        .for('update', { skipLocked: true })
      if (dueCandidates.length > 0) {
        await tx.delete(memoryCandidates)
          .where(inArray(memoryCandidates.id, dueCandidates.map(({ id }) => id)))
      }
      return {
        memoriesDeleted: dueMemories.length,
        candidatesDeleted: dueCandidates.length,
      }
    })
  }

  async inspectExpiryBacklog(alertThreshold = 1_000) {
    if (!Number.isInteger(alertThreshold) || alertThreshold < 1 || alertThreshold > 10_000) {
      throw new Error('Memory expiry alert threshold must be an integer between 1 and 10000')
    }
    const [dueMemories, dueCandidates] = await Promise.all([
      this.db
        .select({ id: memories.id })
        .from(memories)
        .where(lte(memories.expiresAt, sql`clock_timestamp()`))
        .orderBy(asc(memories.expiresAt), asc(memories.id))
        .limit(alertThreshold),
      this.db
        .select({ id: memoryCandidates.id })
        .from(memoryCandidates)
        .where(lte(memoryCandidates.expiresAt, sql`clock_timestamp()`))
        .orderBy(asc(memoryCandidates.expiresAt), asc(memoryCandidates.id))
        .limit(alertThreshold),
    ])
    return {
      memoriesDue: dueMemories.length,
      memoriesCapped: dueMemories.length === alertThreshold,
      candidatesDue: dueCandidates.length,
      candidatesCapped: dueCandidates.length === alertThreshold,
    }
  }
}

export function createMemoryRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new MemoryRepository(db)
}
