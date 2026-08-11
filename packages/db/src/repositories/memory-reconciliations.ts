import {
  MemoryExtractionBudgetPolicySchema,
  type MemoryExtractionBudgetPolicy,
  type MemorySourcePointer,
} from '@vibe-writer/memory-core'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  memoryExtractionAttempts,
  memoryExtractionEffects,
  memoryExtractionReconciliations,
  memoryExtractionTasks,
} from '../schema'
import {
  fingerprintEffectRequest,
  type VibeDatabase,
} from './jobs'
import type {
  MemoryExtractionCost,
  MemoryExtractionUsage,
} from './memory-extractions'
import {
  requireWorkspaceOwner,
  setWorkspaceSession,
  type AuthorizedWorkspaceScope,
} from './workspaces'

const CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/

function code(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !CODE_PATTERN.test(normalized)) {
    throw new Error(`${name} must be a lowercase machine-readable code`)
  }
  return normalized
}

function identifier(value: string, name: string, maximum = 256): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${name} must contain 1-${maximum} non-whitespace characters`)
  }
  return normalized
}

function fingerprint(value: string, name: string): string {
  const normalized = value.trim()
  if (!FINGERPRINT_PATTERN.test(normalized)) {
    throw new Error(`${name} must be a lowercase SHA-256 fingerprint`)
  }
  return normalized
}

function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a nonnegative database integer`)
  }
  return value
}

function normalizeUsage(usage: MemoryExtractionUsage | undefined) {
  if (!usage) return null
  return {
    inputTokens: nonnegative(usage.inputTokens, 'usage.inputTokens'),
    outputTokens: nonnegative(usage.outputTokens, 'usage.outputTokens'),
    cacheReadInputTokens: usage.cacheReadInputTokens === undefined
      ? null
      : nonnegative(usage.cacheReadInputTokens, 'usage.cacheReadInputTokens'),
    cacheWriteInputTokens: usage.cacheWriteInputTokens === undefined
      ? null
      : nonnegative(usage.cacheWriteInputTokens, 'usage.cacheWriteInputTokens'),
  }
}

function normalizeCost(cost: MemoryExtractionCost | undefined) {
  if (!cost) return null
  if (cost.currency !== 'USD') throw new Error('cost.currency must be USD')
  return {
    microusd: nonnegative(cost.microusd, 'cost.microusd'),
    pricingVersion: identifier(cost.pricingVersion, 'cost.pricingVersion'),
    currency: cost.currency,
  }
}

export type ReconcileMemoryExtractionInput = {
  source: MemorySourcePointer
  effectId: string
  idempotencyKey: string
  decision: 'confirmed_failed' | 'confirmed_succeeded'
  retryDisposition: 'hold' | 'requeue'
  maxAttempts?: number
  evidence: {
    kind: 'provider_lookup' | 'billing_export' | 'operator_attestation'
    fingerprint: string
    providerRequestId?: string
    providerResponseId?: string
  }
  reasonCode: string
  usage?: MemoryExtractionUsage
  cost?: MemoryExtractionCost
}

export type MemoryExtractionLookupTarget = {
  source: MemorySourcePointer
  sourceDeleted: boolean
  effectId: string
  provider: string
  model: string
  providerRequestId: string | null
  providerResponseId: string | null
  budget: MemoryExtractionBudgetPolicy | null
}

export type MemoryExtractionLookupPreparation =
  | { status: 'lookup_required'; target: MemoryExtractionLookupTarget }
  | {
      status: 'already_reconciled'
      providerStatus: 'succeeded' | 'failed'
      reconciliation: typeof memoryExtractionReconciliations.$inferSelect
    }

export class MemoryExtractionReconciliationRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async prepareLookup(
    scope: AuthorizedWorkspaceScope,
    input: { source: MemorySourcePointer; effectId: string; idempotencyKey: string },
  ): Promise<MemoryExtractionLookupPreparation> {
    requireWorkspaceOwner(scope)
    const sourceId = input.source.kind === 'run' ? input.source.runId : input.source.signalId
    const effectId = identifier(input.effectId, 'effectId')
    const idempotencyKey = identifier(input.idempotencyKey, 'idempotencyKey')
    const existing = await this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [reconciliation] = await scoped
        .select()
        .from(memoryExtractionReconciliations)
        .where(and(
          eq(memoryExtractionReconciliations.workspaceId, scope.workspaceId),
          eq(memoryExtractionReconciliations.idempotencyKey, idempotencyKey),
        ))
        .limit(1)
      return reconciliation
    })
    if (existing) {
      if (existing.sourceId !== sourceId || existing.effectId !== effectId) {
        throw new Error('Memory reconciliation idempotency collision')
      }
      return {
        status: 'already_reconciled',
        providerStatus: existing.decision === 'confirmed_succeeded' ? 'succeeded' : 'failed',
        reconciliation: existing,
      }
    }
    return {
      status: 'lookup_required',
      target: await this.getLookupTarget(scope, { source: input.source, effectId }),
    }
  }

  async getLookupTarget(
    scope: AuthorizedWorkspaceScope,
    input: { source: MemorySourcePointer; effectId: string },
  ): Promise<MemoryExtractionLookupTarget> {
    requireWorkspaceOwner(scope)
    const sourceId = input.source.kind === 'run' ? input.source.runId : input.source.signalId
    const effectId = identifier(input.effectId, 'effectId')
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [task] = await scoped
        .select()
        .from(memoryExtractionTasks)
        .where(and(
          eq(memoryExtractionTasks.sourceId, sourceId),
          eq(memoryExtractionTasks.sourceKind, input.source.kind),
          eq(memoryExtractionTasks.workspaceId, scope.workspaceId),
        ))
        .limit(1)
      if (!task) throw new Error('Memory extraction task not found in workspace')
      const [effect] = await scoped
        .select()
        .from(memoryExtractionEffects)
        .where(and(
          eq(memoryExtractionEffects.id, effectId),
          eq(memoryExtractionEffects.sourceId, task.sourceId),
          eq(memoryExtractionEffects.workspaceId, scope.workspaceId),
        ))
        .limit(1)
      if (!effect) throw new Error('Memory extraction effect not found in workspace')
      const [attempt] = await scoped
        .select()
        .from(memoryExtractionAttempts)
        .where(and(
          eq(memoryExtractionAttempts.id, effect.attemptId),
          eq(memoryExtractionAttempts.sourceId, task.sourceId),
          eq(memoryExtractionAttempts.workspaceId, scope.workspaceId),
        ))
        .limit(1)
      if (!attempt) throw new Error('Memory extraction attempt is missing')
      if (task.status !== 'uncertain' || attempt.status !== 'uncertain' || effect.status !== 'uncertain') {
        throw new Error('Memory provider lookup requires uncertain task, attempt, and effect')
      }
      const budget = task.executionSnapshot?.budget
        ? MemoryExtractionBudgetPolicySchema.parse(task.executionSnapshot.budget)
        : null
      if (
        effect.budgetDay &&
        (!budget || budget.pricing.version !== effect.reservationPricingVersion)
      ) {
        throw new Error('Memory provider lookup budget snapshot is inconsistent')
      }
      return {
        source: input.source,
        sourceDeleted: task.sourceDeletedAt !== null,
        effectId: effect.id,
        provider: effect.provider,
        model: effect.model,
        providerRequestId: effect.providerRequestId,
        providerResponseId: effect.providerResponseId,
        budget,
      }
    })
  }

  async reconcile(
    scope: AuthorizedWorkspaceScope,
    input: ReconcileMemoryExtractionInput,
  ) {
    requireWorkspaceOwner(scope)
    const sourceId = input.source.kind === 'run' ? input.source.runId : input.source.signalId
    const effectId = identifier(input.effectId, 'effectId')
    const idempotencyKey = identifier(input.idempotencyKey, 'idempotencyKey')
    const reasonCode = code(input.reasonCode, 'reasonCode')
    const evidenceKind = input.evidence.kind
    const evidenceFingerprint = fingerprint(input.evidence.fingerprint, 'evidence.fingerprint')
    const providerRequestId = input.evidence.providerRequestId
      ? identifier(input.evidence.providerRequestId, 'evidence.providerRequestId', 512)
      : null
    const providerResponseId = input.evidence.providerResponseId
      ? identifier(input.evidence.providerResponseId, 'evidence.providerResponseId', 512)
      : null
    const usage = normalizeUsage(input.usage)
    const cost = normalizeCost(input.cost)
    if (input.decision === 'confirmed_succeeded' && input.retryDisposition !== 'hold') {
      throw new Error('Confirmed provider success cannot be requeued')
    }
    let maxAttempts: number | null = null
    if (input.retryDisposition === 'requeue') {
      if (
        input.decision !== 'confirmed_failed' ||
        !Number.isInteger(input.maxAttempts) ||
        (input.maxAttempts ?? 0) < 1 ||
        (input.maxAttempts ?? 0) > 10
      ) {
        throw new Error('Requeue requires a confirmed failure and maxAttempts between 1 and 10')
      }
      maxAttempts = input.maxAttempts!
    } else if (input.maxAttempts !== undefined) {
      throw new Error('maxAttempts is only valid for requeue')
    }
    const resolutionFingerprint = fingerprintEffectRequest({
      source: input.source,
      effectId,
      decision: input.decision,
      retryDisposition: input.retryDisposition,
      maxAttempts,
      evidence: {
        kind: evidenceKind,
        fingerprint: evidenceFingerprint,
        providerRequestId,
        providerResponseId,
      },
      reasonCode,
      usage,
      cost,
    })

    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [idempotent] = await scoped
        .select()
        .from(memoryExtractionReconciliations)
        .where(and(
          eq(memoryExtractionReconciliations.workspaceId, scope.workspaceId),
          eq(memoryExtractionReconciliations.idempotencyKey, idempotencyKey),
        ))
        .limit(1)
      if (idempotent) {
        if (idempotent.resolutionFingerprint !== resolutionFingerprint) {
          throw new Error('Memory reconciliation idempotency collision')
        }
        return { status: 'reconciled' as const, reconciliation: idempotent, replayed: true }
      }
      const [task] = await scoped
        .select()
        .from(memoryExtractionTasks)
        .where(and(
          eq(memoryExtractionTasks.sourceId, sourceId),
          eq(memoryExtractionTasks.sourceKind, input.source.kind),
          eq(memoryExtractionTasks.workspaceId, scope.workspaceId),
        ))
        .for('update')
        .limit(1)
      if (!task) throw new Error('Memory extraction task not found in workspace')
      const [effect] = await scoped
        .select()
        .from(memoryExtractionEffects)
        .where(and(
          eq(memoryExtractionEffects.id, effectId),
          eq(memoryExtractionEffects.sourceId, task.sourceId),
          eq(memoryExtractionEffects.workspaceId, scope.workspaceId),
        ))
        .for('update')
        .limit(1)
      if (!effect) throw new Error('Memory extraction effect not found in workspace')
      const [attempt] = await scoped
        .select()
        .from(memoryExtractionAttempts)
        .where(and(
          eq(memoryExtractionAttempts.id, effect.attemptId),
          eq(memoryExtractionAttempts.sourceId, task.sourceId),
        ))
        .for('update')
        .limit(1)
      if (!attempt) throw new Error('Memory extraction attempt is missing')
      const [effectResolution] = await scoped
        .select()
        .from(memoryExtractionReconciliations)
        .where(eq(memoryExtractionReconciliations.effectId, effect.id))
        .limit(1)
      if (effectResolution) {
        if (effectResolution.resolutionFingerprint !== resolutionFingerprint) {
          throw new Error('Memory extraction effect already has a different reconciliation')
        }
        return { status: 'reconciled' as const, reconciliation: effectResolution, replayed: true }
      }
      if (task.status !== 'uncertain' || attempt.status !== 'uncertain' || effect.status !== 'uncertain') {
        throw new Error('Memory reconciliation requires uncertain task, attempt, and effect')
      }
      if (
        providerRequestId && effect.providerRequestId &&
        providerRequestId !== effect.providerRequestId
      ) {
        throw new Error('Memory reconciliation provider request identity collision')
      }
      if (
        providerResponseId && effect.providerResponseId &&
        providerResponseId !== effect.providerResponseId
      ) {
        throw new Error('Memory reconciliation provider response identity collision')
      }
      if (effect.budgetDay) {
        if (!usage || !cost) {
          throw new Error('Budgeted Memory reconciliation requires usage and cost evidence')
        }
        if (cost.pricingVersion !== effect.reservationPricingVersion) {
          throw new Error('Memory reconciliation pricing snapshot collision')
        }
      }
      const shouldRequeue = input.retryDisposition === 'requeue'
      if (shouldRequeue) {
        if (task.sourceDeletedAt || (!task.sourceRunId && !task.sourceSignalId)) {
          throw new Error('Erased Memory source cannot be requeued')
        }
        if (task.attempt >= maxAttempts!) {
          throw new Error('Memory reconciliation retry budget is exhausted')
        }
      }
      const effectError = input.decision === 'confirmed_failed'
        ? {
            errorCode: 'reconciled_provider_failed',
            errorMessage: 'Provider evidence confirmed that Memory extraction failed.',
          }
        : { errorCode: null, errorMessage: null }
      const effectResultFingerprint = fingerprintEffectRequest({
        reconciliation: resolutionFingerprint,
        outcome: input.decision === 'confirmed_failed' ? 'failed' : 'succeeded',
      })
      await scoped
        .update(memoryExtractionEffects)
        .set({
          status: input.decision === 'confirmed_failed' ? 'failed' : 'succeeded',
          resultFingerprint: effectResultFingerprint,
          providerRequestId: providerRequestId ?? effect.providerRequestId,
          providerResponseId: providerResponseId ?? effect.providerResponseId,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
          cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
          costMicrousd: cost?.microusd ?? null,
          pricingVersion: cost?.pricingVersion ?? null,
          costCurrency: cost?.currency ?? null,
          ...effectError,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryExtractionEffects.id, effect.id))
      const terminalCode = input.decision === 'confirmed_failed'
        ? 'reconciled_provider_failed'
        : 'reconciled_result_unavailable'
      const terminalMessage = input.decision === 'confirmed_failed'
        ? 'Provider evidence confirmed that Memory extraction failed.'
        : 'Provider success was confirmed but its Memory extraction result is unavailable.'
      await scoped
        .update(memoryExtractionAttempts)
        .set({
          status: 'failed',
          errorCode: terminalCode,
          errorMessage: terminalMessage,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryExtractionAttempts.id, attempt.id))
      await scoped
        .update(memoryExtractionTasks)
        .set(shouldRequeue
          ? {
              status: 'queued',
              resultMetadata: null,
              errorCode: null,
              errorMessage: null,
              finishedAt: null,
              updatedAt: sql`clock_timestamp()`,
            }
          : {
              status: 'failed',
              resultMetadata: null,
              errorCode: terminalCode,
              errorMessage: terminalMessage,
              finishedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
        .where(eq(memoryExtractionTasks.sourceId, task.sourceId))
      const [reconciliation] = await scoped
        .insert(memoryExtractionReconciliations)
        .values({
          workspaceId: scope.workspaceId,
          sourceId: task.sourceId,
          attemptId: attempt.id,
          effectId: effect.id,
          idempotencyKey,
          resolutionFingerprint,
          decision: input.decision,
          retryDisposition: input.retryDisposition,
          maxAttempts,
          evidenceKind,
          evidenceFingerprint,
          reasonCode,
          resolvedByPrincipalId: scope.principalId,
          providerRequestId: providerRequestId ?? effect.providerRequestId,
          providerResponseId: providerResponseId ?? effect.providerResponseId,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
          cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
          costMicrousd: cost?.microusd ?? null,
          pricingVersion: cost?.pricingVersion ?? null,
          costCurrency: cost?.currency ?? null,
        })
        .returning()
      if (!reconciliation) throw new Error('Memory reconciliation audit was not created')
      return { status: 'reconciled' as const, reconciliation, replayed: false }
    })
  }

  async listForSource(scope: AuthorizedWorkspaceScope, source: MemorySourcePointer) {
    requireWorkspaceOwner(scope)
    const sourceId = source.kind === 'run' ? source.runId : source.signalId
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      return scoped
        .select()
        .from(memoryExtractionReconciliations)
        .where(and(
          eq(memoryExtractionReconciliations.workspaceId, scope.workspaceId),
          eq(memoryExtractionReconciliations.sourceId, sourceId),
        ))
        .orderBy(asc(memoryExtractionReconciliations.createdAt))
    })
  }
}

export function createMemoryExtractionReconciliationRepository<
  TQueryResult extends PgQueryResultHKT,
>(db: VibeDatabase<TQueryResult>) {
  return new MemoryExtractionReconciliationRepository(db)
}
