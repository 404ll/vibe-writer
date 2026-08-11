import { and, asc, eq, gt, isNotNull, or, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  articles,
  evalCandidateEvents,
  evalCandidates,
  evalSamplingPolicies,
  jobs,
  runs,
} from '../schema'
import type { VibeDatabase } from './jobs'
import { liveEvalSamplingBucket } from './eval-candidates'
import {
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

function boundedInteger(value: number, name: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function databaseDate(value: Date | string, name: string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is not a valid database timestamp`)
  return date
}

export type ConfigureEvalSamplingPolicyInput = {
  samplerKey: string
  samplerVersion: string
  sampleRateBps: number
  consentPolicyVersion: string
  retentionDays: number
}

export type ScanEvalSamplingPoliciesInput = {
  policyLimit: number
  sourceBatchSize: number
}

export class EvalSamplingRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async configurePolicy(
    scope: AuthorizedWorkspaceScope,
    input: ConfigureEvalSamplingPolicyInput,
  ) {
    requireWorkspaceOwner(scope)
    const values = {
      workspaceId: scope.workspaceId,
      samplerKey: code(input.samplerKey, 'samplerKey'),
      samplerVersion: code(input.samplerVersion, 'samplerVersion'),
      sampleRateBps: boundedInteger(input.sampleRateBps, 'sampleRateBps', 1, 10_000),
      consentPolicyVersion: code(input.consentPolicyVersion, 'consentPolicyVersion'),
      retentionDays: boundedInteger(input.retentionDays, 'retentionDays', 1, 365),
      configuredByPrincipalId: scope.principalId,
    }
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const policies = await scoped
        .select()
        .from(evalSamplingPolicies)
        .where(and(
          eq(evalSamplingPolicies.workspaceId, scope.workspaceId),
          eq(evalSamplingPolicies.samplerKey, values.samplerKey),
        ))
        .for('update')
      const sameVersion = policies.find(
        (policy) => policy.samplerVersion === values.samplerVersion,
      )
      if (sameVersion) {
        if (
          sameVersion.status === 'active' &&
          sameVersion.sampleRateBps === values.sampleRateBps &&
          sameVersion.consentPolicyVersion === values.consentPolicyVersion &&
          sameVersion.retentionDays === values.retentionDays
        ) {
          return { policy: sameVersion, created: false }
        }
        throw new Error(
          `Eval sampling policy version collision: ${values.samplerKey}@${values.samplerVersion}`,
        )
      }
      const active = policies.find((policy) => policy.status === 'active')
      if (active) {
        await scoped
          .update(evalSamplingPolicies)
          .set({
            status: 'disabled',
            disabledAt: sql`clock_timestamp()`,
            disabledByPrincipalId: scope.principalId,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(
            eq(evalSamplingPolicies.id, active.id),
            eq(evalSamplingPolicies.status, 'active'),
          ))
      }
      const [created] = await scoped
        .insert(evalSamplingPolicies)
        .values({
          ...values,
          cursorFinishedAt: active?.cursorFinishedAt ?? null,
          cursorRunId: active?.cursorRunId ?? null,
        })
        .returning()
      if (!created) throw new Error('Eval sampling policy creation failed')
      return { policy: created, created: true }
    })
  }

  async disablePolicy(
    scope: AuthorizedWorkspaceScope,
    policyId: string,
  ) {
    requireWorkspaceOwner(scope)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [policy] = await scoped
        .select()
        .from(evalSamplingPolicies)
        .where(and(
          eq(evalSamplingPolicies.id, policyId),
          eq(evalSamplingPolicies.workspaceId, scope.workspaceId),
        ))
        .for('update')
        .limit(1)
      if (!policy) throw new Error('Eval sampling policy not found in workspace')
      if (policy.status === 'disabled') return { policy, changed: false }
      const [disabled] = await scoped
        .update(evalSamplingPolicies)
        .set({
          status: 'disabled',
          disabledAt: sql`clock_timestamp()`,
          disabledByPrincipalId: scope.principalId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(
          eq(evalSamplingPolicies.id, policy.id),
          eq(evalSamplingPolicies.status, 'active'),
        ))
        .returning()
      if (!disabled) throw new Error('Eval sampling policy disable lost its row lock')
      return { policy: disabled, changed: true }
    })
  }

  async listPolicies(scope: AuthorizedWorkspaceScope) {
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      return scoped
        .select()
        .from(evalSamplingPolicies)
        .where(eq(evalSamplingPolicies.workspaceId, scope.workspaceId))
        .orderBy(evalSamplingPolicies.createdAt)
    })
  }

  async scanActivePolicies(input: ScanEvalSamplingPoliciesInput) {
    const policyLimit = boundedInteger(input.policyLimit, 'policyLimit', 1, 100)
    const sourceBatchSize = boundedInteger(
      input.sourceBatchSize,
      'sourceBatchSize',
      1,
      1_000,
    )
    return this.db.transaction(async (tx) => {
      const policies = await tx
        .select()
        .from(evalSamplingPolicies)
        .where(eq(evalSamplingPolicies.status, 'active'))
        .orderBy(
          sql`${evalSamplingPolicies.lastScannedAt} asc nulls first`,
          evalSamplingPolicies.id,
        )
        .limit(policyLimit)
        .for('update', { skipLocked: true })
      let sourcesSeen = 0
      let candidatesCreated = 0
      let candidatesExisting = 0
      let cursorsAdvanced = 0
      for (const policy of policies) {
        const afterCursor = policy.cursorFinishedAt && policy.cursorRunId
          ? or(
              gt(runs.finishedAt, policy.cursorFinishedAt),
              and(
                eq(runs.finishedAt, policy.cursorFinishedAt),
                gt(runs.id, policy.cursorRunId),
              ),
            )
          : undefined
        const sources = await tx
          .select({
            runId: runs.id,
            runFinishedAt: runs.finishedAt,
            jobId: jobs.id,
            workspaceId: jobs.workspaceId,
            articleId: articles.id,
            articleRevision: articles.revision,
            articleContentFingerprint: articles.contentFingerprint,
            databaseNow: sql<Date>`clock_timestamp()`,
          })
          .from(runs)
          .innerJoin(jobs, eq(jobs.id, runs.jobId))
          .leftJoin(articles, and(
            eq(articles.jobId, jobs.id),
            eq(articles.sourceRunId, runs.id),
          ))
          .where(and(
            eq(jobs.workspaceId, policy.workspaceId),
            eq(jobs.status, 'completed'),
            eq(runs.status, 'completed'),
            isNotNull(runs.finishedAt),
            afterCursor,
          ))
          .orderBy(asc(runs.finishedAt), asc(runs.id))
          .limit(sourceBatchSize)
        for (const source of sources) {
          if (
            !source.runFinishedAt || !source.articleId ||
            source.articleRevision === null || !source.articleContentFingerprint
          ) {
            throw new Error(`Completed run ${source.runId} is missing its source article`)
          }
          sourcesSeen += 1
          const samplingBucket = liveEvalSamplingBucket({
            workspaceId: source.workspaceId,
            sourceRunId: source.runId,
            samplerKey: policy.samplerKey,
            samplerVersion: policy.samplerVersion,
          })
          if (samplingBucket >= policy.sampleRateBps) continue
          const retentionUntil = new Date(
            databaseDate(source.databaseNow as Date | string, 'databaseNow').getTime() +
              policy.retentionDays * 86_400_000,
          )
          const values = {
            workspaceId: source.workspaceId,
            samplingPolicyId: policy.id,
            jobId: source.jobId,
            sourceRunId: source.runId,
            sourceArticleId: source.articleId,
            sourceRevision: source.articleRevision,
            contentFingerprint: source.articleContentFingerprint,
            samplerKey: policy.samplerKey,
            samplerVersion: policy.samplerVersion,
            samplingBucket,
            sampleRateBps: policy.sampleRateBps,
            consentBasis: 'workspace_policy' as const,
            consentPolicyVersion: policy.consentPolicyVersion,
            dataClassification: 'user_content' as const,
            retentionUntil,
          }
          const [created] = await tx
            .insert(evalCandidates)
            .values(values)
            .onConflictDoNothing()
            .returning()
          if (created) {
            candidatesCreated += 1
            await tx.insert(evalCandidateEvents).values({
              candidateId: created.id,
              seq: 0,
              eventType: 'sampled',
              actorPrincipalId: null,
              reasonCode: 'workspace_policy_sample_selected',
            })
            continue
          }
          const [existing] = await tx
            .select()
            .from(evalCandidates)
            .where(and(
              eq(evalCandidates.sourceRunId, source.runId),
              eq(evalCandidates.samplerKey, policy.samplerKey),
              eq(evalCandidates.samplerVersion, policy.samplerVersion),
            ))
            .limit(1)
          if (
            !existing || existing.samplingPolicyId !== policy.id ||
            existing.workspaceId !== values.workspaceId ||
            existing.sourceArticleId !== values.sourceArticleId ||
            existing.sourceRevision !== values.sourceRevision ||
            existing.contentFingerprint !== values.contentFingerprint ||
            existing.sampleRateBps !== values.sampleRateBps ||
            existing.consentPolicyVersion !== values.consentPolicyVersion
          ) {
            throw new Error(
              `Eval scanner candidate collision: ${policy.samplerKey}@${policy.samplerVersion}/${source.runId}`,
            )
          }
          candidatesExisting += 1
        }
        const last = sources.at(-1)
        const [scanned] = await tx
          .update(evalSamplingPolicies)
          .set(last?.runFinishedAt
            ? {
              cursorFinishedAt: last.runFinishedAt,
              cursorRunId: last.runId,
              lastScannedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            }
            : {
              lastScannedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
          .where(and(
            eq(evalSamplingPolicies.id, policy.id),
            eq(evalSamplingPolicies.status, 'active'),
          ))
          .returning({ id: evalSamplingPolicies.id })
        if (!scanned) throw new Error('Eval sampling scan lost its policy lock')
        if (last?.runFinishedAt) {
          cursorsAdvanced += 1
        }
      }
      return {
        policiesScanned: policies.length,
        sourcesSeen,
        candidatesCreated,
        candidatesExisting,
        cursorsAdvanced,
      }
    })
  }
}

export function createEvalSamplingRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new EvalSamplingRepository(db)
}
