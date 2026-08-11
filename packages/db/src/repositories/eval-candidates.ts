import { createHash } from 'node:crypto'
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { EvalConsentBasis } from '../domain'
import {
  articles,
  evalCandidateEvents,
  evalCandidates,
  evalCases,
  evalSuites,
  jobs,
  runs,
} from '../schema'
import type { VibeDatabase } from './jobs'
import {
  requireWorkspaceEditor,
  setWorkspaceSession,
  type AuthorizedWorkspaceScope,
} from './workspaces'

const CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/

function code(value: string, name: string, maxLength = 256): string {
  const normalized = value.trim()
  if (
    !normalized || normalized.length > maxLength ||
    !CODE_PATTERN.test(normalized)
  ) {
    throw new Error(`${name} must be a lowercase machine-readable code`)
  }
  return normalized
}

function sampleRate(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error('sampleRateBps must be an integer between 1 and 10000')
  }
  return value
}

function retention(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('retentionUntil must be a valid Date')
  }
  return value
}

export function liveEvalSamplingBucket(input: {
  workspaceId: string
  sourceRunId: string
  samplerKey: string
  samplerVersion: string
}): number {
  const digest = createHash('sha256')
    .update(input.workspaceId)
    .update('\0')
    .update(input.sourceRunId)
    .update('\0')
    .update(code(input.samplerKey, 'samplerKey'))
    .update('\0')
    .update(code(input.samplerVersion, 'samplerVersion'))
    .digest()
  return digest.readUInt32BE(0) % 10_000
}

export type SampleCompletedRunInput = {
  sourceRunId: string
  samplerKey: string
  samplerVersion: string
  sampleRateBps: number
  consent: {
    basis: EvalConsentBasis
    policyVersion: string
  } | null
  retentionUntil: Date
}

export type ReviewEvalCandidateInput = {
  candidateId: string
  decision: 'approved' | 'rejected'
  reasonCode: string
}

export class EvalCandidateRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async sampleCompletedRun(input: SampleCompletedRunInput) {
    const samplerKey = code(input.samplerKey, 'samplerKey')
    const samplerVersion = code(input.samplerVersion, 'samplerVersion')
    const rate = sampleRate(input.sampleRateBps)
    const retentionUntil = retention(input.retentionUntil)
    if (!input.consent) {
      return { status: 'not_selected' as const, reason: 'consent_missing' as const }
    }
    const consentBasis = input.consent.basis
    if (!['workspace_policy', 'explicit_user'].includes(consentBasis)) {
      throw new Error('Unsupported Eval consent basis')
    }
    const consentPolicyVersion = code(
      input.consent.policyVersion,
      'consent.policyVersion',
    )

    return this.db.transaction(async (tx) => {
      const [source] = await tx
        .select({
          runId: runs.id,
          runStatus: runs.status,
          jobId: jobs.id,
          jobStatus: jobs.status,
          workspaceId: jobs.workspaceId,
          articleId: articles.id,
          articleRevision: articles.revision,
          articleContentFingerprint: articles.contentFingerprint,
          databaseNow: sql<Date>`clock_timestamp()`,
        })
        .from(runs)
        .innerJoin(jobs, eq(jobs.id, runs.jobId))
        .innerJoin(articles, and(
          eq(articles.jobId, jobs.id),
          eq(articles.sourceRunId, runs.id),
        ))
        .where(eq(runs.id, input.sourceRunId))
        .limit(1)
      if (!source) throw new Error('Completed source run with an article was not found')
      if (source.runStatus !== 'completed' || source.jobStatus !== 'completed') {
        throw new Error('Only a completed source run can become an Eval candidate')
      }
      if (retentionUntil <= source.databaseNow) {
        throw new Error('retentionUntil must be in the future')
      }
      const samplingBucket = liveEvalSamplingBucket({
        workspaceId: source.workspaceId,
        sourceRunId: source.runId,
        samplerKey,
        samplerVersion,
      })
      if (samplingBucket >= rate) {
        return { status: 'not_selected' as const, reason: 'sample_rate' as const, samplingBucket }
      }
      const values = {
        workspaceId: source.workspaceId,
        jobId: source.jobId,
        sourceRunId: source.runId,
        sourceArticleId: source.articleId,
        sourceRevision: source.articleRevision,
        contentFingerprint: source.articleContentFingerprint,
        samplerKey,
        samplerVersion,
        samplingBucket,
        sampleRateBps: rate,
        consentBasis,
        consentPolicyVersion,
        dataClassification: 'user_content' as const,
        retentionUntil,
      }
      const [created] = await tx
        .insert(evalCandidates)
        .values(values)
        .onConflictDoNothing()
        .returning()
      if (!created) {
        const [existing] = await tx
          .select()
          .from(evalCandidates)
          .where(and(
            eq(evalCandidates.sourceRunId, source.runId),
            eq(evalCandidates.samplerKey, samplerKey),
            eq(evalCandidates.samplerVersion, samplerVersion),
          ))
          .limit(1)
        if (!existing) throw new Error('Eval candidate idempotent lookup failed')
        if (
          existing.samplingPolicyId !== null ||
          existing.workspaceId !== values.workspaceId ||
          existing.jobId !== values.jobId ||
          existing.sourceArticleId !== values.sourceArticleId ||
          existing.sourceRevision !== values.sourceRevision ||
          existing.contentFingerprint !== values.contentFingerprint ||
          existing.samplingBucket !== values.samplingBucket ||
          existing.sampleRateBps !== values.sampleRateBps ||
          existing.consentBasis !== values.consentBasis ||
          existing.consentPolicyVersion !== values.consentPolicyVersion ||
          existing.retentionUntil.getTime() !== values.retentionUntil.getTime()
        ) {
          throw new Error(`Eval sampler version collision: ${samplerKey}@${samplerVersion}`)
        }
        return { status: 'selected' as const, candidate: existing, created: false }
      }
      await tx.insert(evalCandidateEvents).values({
        candidateId: created.id,
        seq: 0,
        eventType: 'sampled',
        actorPrincipalId: null,
        reasonCode: 'deterministic_sample_selected',
      })
      return { status: 'selected' as const, candidate: created, created: true }
    })
  }

  async reviewCandidate(
    scope: AuthorizedWorkspaceScope,
    input: ReviewEvalCandidateInput,
  ) {
    requireWorkspaceEditor(scope)
    const reasonCode = code(input.reasonCode, 'reasonCode')
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [candidate] = await scoped
        .select({
          row: evalCandidates,
          databaseNow: sql<Date>`clock_timestamp()`,
        })
        .from(evalCandidates)
        .where(and(
          eq(evalCandidates.id, input.candidateId),
          eq(evalCandidates.workspaceId, scope.workspaceId),
        ))
        .for('update')
        .limit(1)
      if (!candidate) throw new Error('Eval candidate not found in workspace')
      if (candidate.row.status === input.decision) {
        if (
          candidate.row.reviewedByPrincipalId !== scope.principalId ||
          candidate.row.decisionReasonCode !== reasonCode
        ) {
          throw new Error('Eval candidate review collision')
        }
        return { status: 'reviewed' as const, candidate: candidate.row, replayed: true }
      }
      if (candidate.row.status !== 'pending_review') {
        throw new Error(`Eval candidate is already ${candidate.row.status}`)
      }
      const eventSeq = candidate.row.nextEventSeq
      if (candidate.row.retentionUntil <= candidate.databaseNow) {
        const [expired] = await scoped
          .update(evalCandidates)
          .set({
            status: 'expired',
            nextEventSeq: eventSeq + 1,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(evalCandidates.id, candidate.row.id))
          .returning()
        if (!expired) throw new Error('Eval candidate expiry lost its row lock')
        await scoped.insert(evalCandidateEvents).values({
          candidateId: expired.id,
          seq: eventSeq,
          eventType: 'expired',
          actorPrincipalId: null,
          reasonCode: 'retention_elapsed',
        })
        return { status: 'expired' as const, candidate: expired }
      }
      const [reviewed] = await scoped
        .update(evalCandidates)
        .set({
          status: input.decision,
          reviewedByPrincipalId: scope.principalId,
          reviewedAt: sql`clock_timestamp()`,
          decisionReasonCode: reasonCode,
          nextEventSeq: eventSeq + 1,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(evalCandidates.id, candidate.row.id))
        .returning()
      if (!reviewed) throw new Error('Eval candidate review lost its row lock')
      await scoped.insert(evalCandidateEvents).values({
        candidateId: reviewed.id,
        seq: eventSeq,
        eventType: input.decision,
        actorPrincipalId: scope.principalId,
        reasonCode,
      })
      return { status: 'reviewed' as const, candidate: reviewed, replayed: false }
    })
  }

  async expireDue(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('limit must be an integer between 1 and 1000')
    }
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(evalCandidates)
        .where(and(
          inArray(evalCandidates.status, ['pending_review', 'approved', 'materialized']),
          lte(evalCandidates.retentionUntil, sql`clock_timestamp()`),
        ))
        .limit(limit)
        .for('update', { skipLocked: true })
      const expired = []
      for (const candidate of due) {
        if (candidate.status === 'materialized') {
          const materializedCases = await tx
            .select({ id: evalCases.id, suiteId: evalCases.suiteId })
            .from(evalCases)
            .where(eq(evalCases.sourceCandidateId, candidate.id))
          const suiteIds = [...new Set(materializedCases.map((item) => item.suiteId))]
          if (suiteIds.length > 0) {
            await tx
              .update(evalSuites)
              .set({ status: 'archived', updatedAt: sql`clock_timestamp()` })
              .where(inArray(evalSuites.id, suiteIds))
            await tx
              .delete(evalCases)
              .where(eq(evalCases.sourceCandidateId, candidate.id))
          }
        }
        const [updated] = await tx
          .update(evalCandidates)
          .set({
            status: 'expired',
            nextEventSeq: candidate.nextEventSeq + 1,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(
            eq(evalCandidates.id, candidate.id),
            inArray(evalCandidates.status, ['pending_review', 'approved', 'materialized']),
          ))
          .returning()
        if (!updated) continue
        await tx.insert(evalCandidateEvents).values({
          candidateId: updated.id,
          seq: candidate.nextEventSeq,
          eventType: 'expired',
          actorPrincipalId: null,
          reasonCode: 'retention_elapsed',
        })
        expired.push(updated)
      }
      return expired
    })
  }

  async listForWorkspace(scope: AuthorizedWorkspaceScope) {
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      return scoped
        .select()
        .from(evalCandidates)
        .where(eq(evalCandidates.workspaceId, scope.workspaceId))
        .orderBy(evalCandidates.createdAt)
    })
  }

  async listEventsForWorkspace(
    scope: AuthorizedWorkspaceScope,
    candidateId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [candidate] = await scoped
        .select({ id: evalCandidates.id })
        .from(evalCandidates)
        .where(and(
          eq(evalCandidates.id, candidateId),
          eq(evalCandidates.workspaceId, scope.workspaceId),
        ))
        .limit(1)
      if (!candidate) return []
      return scoped
        .select()
        .from(evalCandidateEvents)
        .where(eq(evalCandidateEvents.candidateId, candidateId))
        .orderBy(evalCandidateEvents.seq)
    })
  }
}

export function createEvalCandidateRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new EvalCandidateRepository(db)
}
