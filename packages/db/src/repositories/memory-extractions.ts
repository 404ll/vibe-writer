import { randomUUID } from 'node:crypto'
import {
  MemoryExtractionBudgetPolicySchema,
  type MemoryExtractionBudgetPolicy,
  type MemorySourcePointer,
} from '@vibe-writer/memory-core'
import { and, asc, eq, gt, inArray, sql, type ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core'
import type { MemoryExtractionExecutionSnapshot } from '../domain'
import * as schema from '../schema'
import {
  jobs,
  memoryExtractionAttempts,
  memoryExtractionEffects,
  memoryExtractionTasks,
  memorySourceSignals,
  runs,
  workspaces,
} from '../schema'
import { fingerprintEffectRequest, type VibeDatabase } from './jobs'
import { createMemoryRepository } from './memories'

const MAX_ERROR_LENGTH = 1_000
const MAX_IDENTIFIER_LENGTH = 256
const MAX_EFFECT_KEY_LENGTH = 512

export type MemoryExtractionLeaseIdentity = {
  sourceId: string
  attemptId: string
  leaseToken: string
}

export type ClaimMemoryExtractionInput = {
  source: MemorySourcePointer
  workerId: string
  leaseDurationMs: number
  maxAttempts: number
  execution: MemoryExtractionExecutionSnapshot
}

export type ClaimMemoryExtractionResult =
  | {
      status: 'claimed'
      task: typeof memoryExtractionTasks.$inferSelect
      attempt: typeof memoryExtractionAttempts.$inferSelect
      identity: MemoryExtractionLeaseIdentity
    }
  | { status: 'not_found' }
  | { status: 'busy' }
  | {
      status: 'terminal'
      taskStatus: 'completed' | 'failed' | 'uncertain' | 'cancelled'
      resultMetadata: Record<string, unknown> | null
    }

export type ReserveMemoryExtractionEffectInput = MemoryExtractionLeaseIdentity & {
  effectKey: string
  requestFingerprint: string
  provider: string
  model: string
  budget?: {
    maximumCostMicrousd: number
    policy: MemoryExtractionBudgetPolicy
  }
}

export type MemoryExtractionUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

export type MemoryExtractionCost = {
  microusd: number
  pricingVersion: string
  currency: 'USD'
}

export type MemoryExtractionEffectMetadata = {
  provider: string
  model: string
  requestId?: string
  responseId?: string
  usage?: MemoryExtractionUsage
  cost?: MemoryExtractionCost
  latencyMs: number
}

export type FinishMemoryExtractionEffectInput = MemoryExtractionLeaseIdentity & {
  effectKey: string
  outcome: 'succeeded' | 'failed' | 'uncertain'
  metadata?: MemoryExtractionEffectMetadata
  errorCode?: string
  errorMessage?: string
}

export type MemoryExtractionCompletionMetadata = {
  proposalCount: number
  candidateCount: number
  conflictCount: number
  duplicateCount: number
  rejectedCount: number
  createdCount: number
  existingCount: number
}

export type FailMemoryExtractionClaimInput = MemoryExtractionLeaseIdentity & {
  outcome: 'failed' | 'uncertain'
  retryable: boolean
  maxAttempts: number
  errorCode: string
  errorMessage: string
}

function identifier(value: string, name: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} non-whitespace characters`)
  }
  return normalized
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`)
  }
  return value
}

function boundedError(value: string): string {
  return value.slice(0, MAX_ERROR_LENGTH)
}

function normalizeExecution(input: MemoryExtractionExecutionSnapshot): MemoryExtractionExecutionSnapshot {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 365) {
    throw new Error('execution.retentionDays must be an integer between 1 and 365')
  }
  return {
    extractorKey: identifier(input.extractorKey, 'execution.extractorKey'),
    extractorVersion: identifier(input.extractorVersion, 'execution.extractorVersion'),
    promptVersion: identifier(input.promptVersion, 'execution.promptVersion'),
    consentPolicyVersion: identifier(
      input.consentPolicyVersion,
      'execution.consentPolicyVersion',
    ),
    retentionDays: input.retentionDays,
    modelProfile: {
      profile: identifier(input.modelProfile.profile, 'execution.modelProfile.profile'),
      provider: identifier(input.modelProfile.provider, 'execution.modelProfile.provider'),
      model: identifier(input.modelProfile.model, 'execution.modelProfile.model'),
    },
    ...(input.budget
      ? { budget: MemoryExtractionBudgetPolicySchema.parse(input.budget) }
      : {}),
  }
}

function executionFingerprint(execution: MemoryExtractionExecutionSnapshot): string {
  return fingerprintEffectRequest({
    extractorKey: execution.extractorKey,
    extractorVersion: execution.extractorVersion,
    promptVersion: execution.promptVersion,
    consentPolicyVersion: execution.consentPolicyVersion,
    retentionDays: execution.retentionDays,
      modelProfile: {
      profile: execution.modelProfile.profile,
      provider: execution.modelProfile.provider,
        model: execution.modelProfile.model,
      },
      ...(execution.budget ? { budget: execution.budget } : {}),
  })
}

function normalizeUsage(usage: MemoryExtractionUsage | undefined) {
  if (!usage) return null
  return {
    inputTokens: nonnegativeInteger(usage.inputTokens, 'usage.inputTokens'),
    outputTokens: nonnegativeInteger(usage.outputTokens, 'usage.outputTokens'),
    cacheReadInputTokens: usage.cacheReadInputTokens === undefined
      ? null
      : nonnegativeInteger(usage.cacheReadInputTokens, 'usage.cacheReadInputTokens'),
    cacheWriteInputTokens: usage.cacheWriteInputTokens === undefined
      ? null
      : nonnegativeInteger(usage.cacheWriteInputTokens, 'usage.cacheWriteInputTokens'),
  }
}

function normalizeCost(cost: MemoryExtractionCost | undefined) {
  if (!cost) return null
  if (cost.currency !== 'USD') throw new Error('cost.currency must be USD')
  return {
    microusd: nonnegativeInteger(cost.microusd, 'cost.microusd'),
    pricingVersion: identifier(cost.pricingVersion, 'cost.pricingVersion'),
    currency: cost.currency,
  }
}

function normalizeCompletion(input: MemoryExtractionCompletionMetadata) {
  const normalized = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, nonnegativeInteger(value, key)]),
  ) as MemoryExtractionCompletionMetadata
  if (
    normalized.createdCount + normalized.existingCount >
    normalized.candidateCount + normalized.conflictCount
  ) {
    throw new Error('Memory extraction completion counts are inconsistent')
  }
  return normalized
}

function terminalError(code: string, message: string) {
  return {
    errorCode: identifier(code, 'errorCode'),
    errorMessage: boundedError(message),
  }
}

type VibeTransaction<TQueryResult extends PgQueryResultHKT> = PgTransaction<
  TQueryResult,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

export async function settleSignalExtractionErasure<
  TQueryResult extends PgQueryResultHKT,
>(
  tx: VibeDatabase<TQueryResult>,
  sourceSignalId: string,
) {
  const [task] = await tx
    .select()
    .from(memoryExtractionTasks)
    .where(and(
      eq(memoryExtractionTasks.sourceKind, 'signal'),
      eq(memoryExtractionTasks.sourceSignalId, sourceSignalId),
    ))
    .for('update')
    .limit(1)
  if (!task) return { status: 'no_task' as const }

  const error = terminalError(
    'source_erased',
    'Memory extraction source was erased by retention or user request.',
  )
  if (task.status === 'running') {
    const [attempt] = await tx
      .select()
      .from(memoryExtractionAttempts)
      .where(and(
        eq(memoryExtractionAttempts.sourceId, task.sourceId),
        eq(memoryExtractionAttempts.attempt, task.attempt),
      ))
      .for('update')
      .limit(1)
    if (!attempt || attempt.status !== 'running') {
      throw new Error('Running Memory extraction attempt is missing during source erasure')
    }
    const effects = await tx
      .select()
      .from(memoryExtractionEffects)
      .where(eq(memoryExtractionEffects.attemptId, attempt.id))
    const unsafe = effects.some((effect) =>
      effect.status === 'reserved' || effect.status === 'succeeded' ||
      effect.status === 'uncertain')
    const outcome = unsafe ? 'uncertain' as const : 'cancelled' as const
    if (unsafe) {
      const resultFingerprint = fingerprintEffectRequest({
        outcome: 'uncertain',
        errorCode: error.errorCode,
        errorMessage: error.errorMessage,
      })
      await tx
        .update(memoryExtractionEffects)
        .set({
          status: 'uncertain',
          resultFingerprint,
          ...error,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(
          eq(memoryExtractionEffects.attemptId, attempt.id),
          eq(memoryExtractionEffects.status, 'reserved'),
        ))
    }
    await tx
      .update(memoryExtractionAttempts)
      .set({
        status: outcome,
        ...error,
        finishedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(memoryExtractionAttempts.id, attempt.id))
    await tx
      .update(memoryExtractionTasks)
      .set({
        sourceSignalId: null,
        sourceDeletedAt: sql`clock_timestamp()`,
        status: outcome,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        ...error,
        finishedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(memoryExtractionTasks.sourceId, task.sourceId))
    return { status: outcome, sourceId: task.sourceId }
  }

  if (task.status === 'queued') {
    await tx
      .update(memoryExtractionTasks)
      .set({
        sourceSignalId: null,
        sourceDeletedAt: sql`clock_timestamp()`,
        status: 'cancelled',
        ...error,
        finishedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(memoryExtractionTasks.sourceId, task.sourceId))
    return { status: 'cancelled' as const, sourceId: task.sourceId }
  }

  await tx
    .update(memoryExtractionTasks)
    .set({
      sourceSignalId: null,
      sourceDeletedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(memoryExtractionTasks.sourceId, task.sourceId))
  return { status: task.status, sourceId: task.sourceId }
}

export class MemoryExtractionRepository<TQueryResult extends PgQueryResultHKT> {
  private readonly memories

  constructor(private readonly db: VibeDatabase<TQueryResult>) {
    this.memories = createMemoryRepository(db)
  }

  async loadExtractionSource(source: MemorySourcePointer) {
    if (source.kind === 'run') {
      const loaded = await this.memories.loadCompletedExtractionSource(source.runId)
      return loaded ? { kind: 'run' as const, ...loaded } : null
    }
    const [loaded] = await this.db
      .select({
        signalId: memorySourceSignals.id,
        workspaceId: memorySourceSignals.workspaceId,
        subjectKind: memorySourceSignals.subjectKind,
        subjectKey: memorySourceSignals.subjectKey,
        text: memorySourceSignals.sourceText,
        evidenceFingerprint: memorySourceSignals.evidenceFingerprint,
        consentPolicyVersion: memorySourceSignals.consentPolicyVersion,
        retentionUntil: memorySourceSignals.retentionUntil,
      })
      .from(memorySourceSignals)
      .where(and(
        eq(memorySourceSignals.id, source.signalId),
        gt(memorySourceSignals.retentionUntil, sql`clock_timestamp()`),
      ))
      .limit(1)
    return loaded ? { kind: 'signal' as const, ...loaded } : null
  }

  submitProposal(proposal: unknown) {
    return this.memories.submitProposal(proposal)
  }

  async claimExtraction(input: ClaimMemoryExtractionInput): Promise<ClaimMemoryExtractionResult> {
    const workerId = identifier(input.workerId, 'workerId')
    const leaseDurationMs = positiveInteger(input.leaseDurationMs, 'leaseDurationMs')
    const maxAttempts = positiveInteger(input.maxAttempts, 'maxAttempts')
    const execution = normalizeExecution(input.execution)
    const fingerprint = executionFingerprint(execution)
    const leaseToken = randomUUID()

    return this.db.transaction(async (tx) => {
      const source = input.source.kind === 'run'
        ? await tx
            .select({
              sourceId: runs.id,
              sourceKind: sql<'run'>`'run'`,
              runStatus: runs.status,
              jobStatus: jobs.status,
              workspaceId: jobs.workspaceId,
            })
            .from(runs)
            .innerJoin(jobs, eq(jobs.id, runs.jobId))
            .where(eq(runs.id, input.source.runId))
            .for('update')
            .limit(1)
            .then(([row]) => row && row.runStatus === 'completed' && row.jobStatus === 'completed'
              ? row
              : null)
        : await tx
            .select({
              sourceId: memorySourceSignals.id,
              sourceKind: sql<'signal'>`'signal'`,
              workspaceId: memorySourceSignals.workspaceId,
            })
            .from(memorySourceSignals)
            .where(and(
              eq(memorySourceSignals.id, input.source.signalId),
              gt(memorySourceSignals.retentionUntil, sql`clock_timestamp()`),
            ))
            .for('update')
            .limit(1)
            .then(([row]) => row ?? null)
      if (!source) {
        return { status: 'not_found' as const }
      }

      let [task] = await tx
        .select()
        .from(memoryExtractionTasks)
        .where(eq(memoryExtractionTasks.sourceId, source.sourceId))
        .limit(1)
      if (!task) {
        ;[task] = await tx
          .insert(memoryExtractionTasks)
          .values({
            sourceId: source.sourceId,
            sourceKind: source.sourceKind,
            sourceRunId: source.sourceKind === 'run' ? source.sourceId : null,
            sourceSignalId: source.sourceKind === 'signal' ? source.sourceId : null,
            workspaceId: source.workspaceId,
          })
          .returning()
      }
      if (!task) throw new Error('Memory extraction task creation failed')
      if (task.workspaceId !== source.workspaceId) {
        throw new Error('Memory extraction task workspace collision')
      }
      if (
        task.sourceKind !== source.sourceKind || task.sourceDeletedAt ||
        (task.sourceKind === 'run' && task.sourceRunId !== source.sourceId) ||
        (task.sourceKind === 'signal' && task.sourceSignalId !== source.sourceId)
      ) {
        throw new Error('Memory extraction source identity collision')
      }
      if (task.executionFingerprint && task.executionFingerprint !== fingerprint) {
        throw new Error('Memory extraction execution snapshot collision')
      }
      if (
        task.status === 'completed' || task.status === 'failed' ||
        task.status === 'uncertain' || task.status === 'cancelled'
      ) {
        return {
          status: 'terminal' as const,
          taskStatus: task.status,
          resultMetadata: task.resultMetadata,
        }
      }

      if (task.status === 'running') {
        const [active] = await tx
          .select({ sourceId: memoryExtractionTasks.sourceId })
          .from(memoryExtractionTasks)
          .where(and(
            eq(memoryExtractionTasks.sourceId, task.sourceId),
            gt(memoryExtractionTasks.leaseExpiresAt, sql`clock_timestamp()`),
          ))
          .limit(1)
        if (active) return { status: 'busy' as const }

        const [currentAttempt] = await tx
          .select()
          .from(memoryExtractionAttempts)
          .where(and(
            eq(memoryExtractionAttempts.sourceId, task.sourceId),
            eq(memoryExtractionAttempts.attempt, task.attempt),
          ))
          .limit(1)
        if (!currentAttempt || currentAttempt.status !== 'running') {
          throw new Error('Running Memory extraction attempt is missing')
        }
        const effects = await tx
          .select()
          .from(memoryExtractionEffects)
          .where(eq(memoryExtractionEffects.attemptId, currentAttempt.id))
        const unsafeReplay = effects.some((effect) =>
          effect.status === 'reserved' || effect.status === 'succeeded' || effect.status === 'uncertain')
        if (unsafeReplay) {
          const error = terminalError(
            'lease_expired_after_provider_reservation',
            'Memory extraction lease expired after the provider effect may have started.',
          )
          const uncertainFingerprint = fingerprintEffectRequest({
            outcome: 'uncertain',
            errorCode: error.errorCode,
            errorMessage: error.errorMessage,
          })
          await tx
            .update(memoryExtractionEffects)
            .set({
              status: 'uncertain',
              resultFingerprint: uncertainFingerprint,
              ...error,
              finishedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(and(
              eq(memoryExtractionEffects.attemptId, currentAttempt.id),
              eq(memoryExtractionEffects.status, 'reserved'),
            ))
          await tx
            .update(memoryExtractionAttempts)
            .set({
              status: 'uncertain',
              ...error,
              finishedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(memoryExtractionAttempts.id, currentAttempt.id))
          const [uncertainTask] = await tx
            .update(memoryExtractionTasks)
            .set({
              status: 'uncertain',
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              ...error,
              finishedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(memoryExtractionTasks.sourceId, task.sourceId))
            .returning()
          return {
            status: 'terminal' as const,
            taskStatus: 'uncertain' as const,
            resultMetadata: uncertainTask?.resultMetadata ?? null,
          }
        }

        const expired = terminalError(
          'lease_expired_before_provider_call',
          'Memory extraction lease expired before a provider effect was reserved.',
        )
        await tx
          .update(memoryExtractionAttempts)
          .set({
            status: 'failed',
            ...expired,
            finishedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(memoryExtractionAttempts.id, currentAttempt.id))
      }

      if (task.attempt >= maxAttempts) {
        const error = terminalError(
          'attempts_exhausted',
          'Memory extraction exhausted its configured attempt budget.',
        )
        const [failedTask] = await tx
          .update(memoryExtractionTasks)
          .set({
            status: 'failed',
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            ...error,
            finishedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(memoryExtractionTasks.sourceId, task.sourceId))
          .returning()
        return {
          status: 'terminal' as const,
          taskStatus: 'failed' as const,
          resultMetadata: failedTask?.resultMetadata ?? null,
        }
      }

      const nextAttempt = task.attempt + 1
      const [claimedTask] = await tx
        .update(memoryExtractionTasks)
        .set({
          status: 'running',
          executionSnapshot: execution,
          executionFingerprint: fingerprint,
          attempt: nextAttempt,
          leaseOwner: workerId,
          leaseToken,
          leaseExpiresAt: sql`clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`,
          heartbeatAt: sql`clock_timestamp()`,
          resultMetadata: null,
          errorCode: null,
          errorMessage: null,
          startedAt: sql`coalesce(${memoryExtractionTasks.startedAt}, clock_timestamp())`,
          finishedAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryExtractionTasks.sourceId, task.sourceId))
        .returning()
      const [attempt] = await tx
        .insert(memoryExtractionAttempts)
        .values({
          sourceId: task.sourceId,
          workspaceId: task.workspaceId,
          attempt: nextAttempt,
          workerId,
          leaseToken,
          status: 'running',
        })
        .returning()
      if (!claimedTask || !attempt) throw new Error('Memory extraction claim failed')
      return {
        status: 'claimed' as const,
        task: claimedTask,
        attempt,
        identity: { sourceId: task.sourceId, attemptId: attempt.id, leaseToken },
      }
    })
  }

  async heartbeatExtraction(identity: MemoryExtractionLeaseIdentity, leaseDurationMs: number) {
    positiveInteger(leaseDurationMs, 'leaseDurationMs')
    const [task] = await this.db
      .update(memoryExtractionTasks)
      .set({
        leaseExpiresAt: sql`clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`,
        heartbeatAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(
        eq(memoryExtractionTasks.sourceId, identity.sourceId),
        eq(memoryExtractionTasks.status, 'running'),
        eq(memoryExtractionTasks.leaseToken, identity.leaseToken),
        gt(memoryExtractionTasks.leaseExpiresAt, sql`clock_timestamp()`),
      ))
      .returning({ sourceId: memoryExtractionTasks.sourceId })
    return task ? 'renewed' as const : 'lease_lost' as const
  }

  private async activeTask(
    tx: VibeTransaction<TQueryResult>,
    identity: MemoryExtractionLeaseIdentity,
  ) {
    const [task] = await tx
      .select()
      .from(memoryExtractionTasks)
      .where(eq(memoryExtractionTasks.sourceId, identity.sourceId))
      .for('update')
      .limit(1)
    if (
      !task || task.status !== 'running' || task.leaseToken !== identity.leaseToken ||
      !task.leaseExpiresAt
    ) return null
    const [active] = await tx
      .select({ sourceId: memoryExtractionTasks.sourceId })
      .from(memoryExtractionTasks)
      .where(and(
        eq(memoryExtractionTasks.sourceId, identity.sourceId),
        gt(memoryExtractionTasks.leaseExpiresAt, sql`clock_timestamp()`),
      ))
      .limit(1)
    if (!active) return null
    const [attempt] = await tx
      .select()
      .from(memoryExtractionAttempts)
      .where(and(
        eq(memoryExtractionAttempts.id, identity.attemptId),
        eq(memoryExtractionAttempts.sourceId, identity.sourceId),
        eq(memoryExtractionAttempts.leaseToken, identity.leaseToken),
        eq(memoryExtractionAttempts.status, 'running'),
      ))
      .limit(1)
    return attempt ? { task, attempt } : null
  }

  async reserveEffect(input: ReserveMemoryExtractionEffectInput) {
    const effectKey = identifier(input.effectKey, 'effectKey', MAX_EFFECT_KEY_LENGTH)
    const requestFingerprint = input.requestFingerprint.trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(requestFingerprint)) {
      throw new Error('requestFingerprint must be a lowercase SHA-256 fingerprint')
    }
    const provider = identifier(input.provider, 'provider')
    const model = identifier(input.model, 'model')
    const budget = input.budget
      ? {
          maximumCostMicrousd: nonnegativeInteger(
            input.budget.maximumCostMicrousd,
            'budget.maximumCostMicrousd',
          ),
          policy: MemoryExtractionBudgetPolicySchema.parse(input.budget.policy),
        }
      : null
    return this.db.transaction(async (tx) => {
      const active = await this.activeTask(tx, input)
      if (!active) return { status: 'lease_lost' as const }
      const executionBudget = active.task.executionSnapshot?.budget
        ? MemoryExtractionBudgetPolicySchema.parse(active.task.executionSnapshot.budget)
        : null
      if (
        (budget === null) !== (executionBudget === null) ||
        (budget && executionBudget &&
          fingerprintEffectRequest(budget.policy) !== fingerprintEffectRequest(executionBudget))
      ) {
        throw new Error('Memory extraction effect budget does not match execution snapshot')
      }
      const [existing] = await tx
        .select()
        .from(memoryExtractionEffects)
        .where(and(
          eq(memoryExtractionEffects.sourceId, input.sourceId),
          eq(memoryExtractionEffects.effectKey, effectKey),
        ))
        .limit(1)
      if (existing) {
        if (
          existing.attemptId !== input.attemptId ||
          existing.requestFingerprint !== requestFingerprint ||
          existing.provider !== provider ||
          existing.model !== model ||
          (budget !== null) !== (existing.budgetDay !== null) ||
          (budget && (
            existing.reservedCostMicrousd !== budget.maximumCostMicrousd ||
            existing.budgetPolicyVersion !== budget.policy.policyVersion ||
            existing.sourceBudgetMicrousd !== budget.policy.maxSourceCostMicrousd ||
            existing.workspaceDailyBudgetMicrousd !==
              budget.policy.maxWorkspaceDailyCostMicrousd ||
            existing.reservationPricingVersion !== budget.policy.pricing.version
          ))
        ) {
          throw new Error(`Memory extraction effect collision: ${effectKey}`)
        }
        return { status: existing.status === 'reserved' ? 'already_reserved' as const : existing.status }
      }
      if (budget) {
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, active.task.workspaceId))
          .for('update')
          .limit(1)
        if (!workspace) throw new Error('Memory extraction workspace is missing')
        const currentBudgetDay = sql`(clock_timestamp() at time zone 'UTC')::date`
        const [dayPolicy] = await tx
          .select({
            policyVersion: memoryExtractionEffects.budgetPolicyVersion,
            workspaceLimit: memoryExtractionEffects.workspaceDailyBudgetMicrousd,
            pricingVersion: memoryExtractionEffects.reservationPricingVersion,
          })
          .from(memoryExtractionEffects)
          .where(and(
            eq(memoryExtractionEffects.workspaceId, active.task.workspaceId),
            sql`${memoryExtractionEffects.budgetDay} = ${currentBudgetDay}`,
          ))
          .limit(1)
        if (dayPolicy && (
          dayPolicy.policyVersion !== budget.policy.policyVersion ||
          dayPolicy.workspaceLimit !== budget.policy.maxWorkspaceDailyCostMicrousd ||
          dayPolicy.pricingVersion !== budget.policy.pricing.version
        )) {
          return { status: 'budget_rejected' as const, reason: 'workspace_policy_drift' as const }
        }
        const countedCost = sql<number>`case
          when ${memoryExtractionEffects.status} in ('reserved', 'uncertain')
            then coalesce(${memoryExtractionEffects.reservedCostMicrousd}, 0)
          else coalesce(${memoryExtractionEffects.costMicrousd}, 0)
        end`
        const [workspaceTotal] = await tx
          .select({ value: sql<number>`coalesce(sum(${countedCost}), 0)::integer` })
          .from(memoryExtractionEffects)
          .where(and(
            eq(memoryExtractionEffects.workspaceId, active.task.workspaceId),
            sql`${memoryExtractionEffects.budgetDay} = ${currentBudgetDay}`,
          ))
        const [sourceTotal] = await tx
          .select({ value: sql<number>`coalesce(sum(${countedCost}), 0)::integer` })
          .from(memoryExtractionEffects)
          .where(eq(memoryExtractionEffects.sourceId, input.sourceId))
        if (
          (sourceTotal?.value ?? 0) + budget.maximumCostMicrousd >
          budget.policy.maxSourceCostMicrousd
        ) {
          return { status: 'budget_rejected' as const, reason: 'source_limit' as const }
        }
        if (
          (workspaceTotal?.value ?? 0) + budget.maximumCostMicrousd >
          budget.policy.maxWorkspaceDailyCostMicrousd
        ) {
          return { status: 'budget_rejected' as const, reason: 'workspace_daily_limit' as const }
        }
      }
      const [effect] = await tx
        .insert(memoryExtractionEffects)
        .values({
          sourceId: input.sourceId,
          attemptId: input.attemptId,
          workspaceId: active.task.workspaceId,
          effectKey,
          requestFingerprint,
          provider,
          model,
          status: 'reserved',
          ...(budget ? {
            budgetDay: sql`(clock_timestamp() at time zone 'UTC')::date`,
            budgetPolicyVersion: budget.policy.policyVersion,
            reservedCostMicrousd: budget.maximumCostMicrousd,
            sourceBudgetMicrousd: budget.policy.maxSourceCostMicrousd,
            workspaceDailyBudgetMicrousd: budget.policy.maxWorkspaceDailyCostMicrousd,
            reservationPricingVersion: budget.policy.pricing.version,
          } : {}),
        })
        .returning()
      if (!effect) throw new Error('Memory extraction effect reservation failed')
      return { status: 'reserved' as const, effect }
    })
  }

  async finishEffect(input: FinishMemoryExtractionEffectInput) {
    const effectKey = identifier(input.effectKey, 'effectKey', MAX_EFFECT_KEY_LENGTH)
    const error = input.outcome === 'succeeded'
      ? null
      : terminalError(input.errorCode ?? 'provider_error', input.errorMessage ?? 'Provider request failed.')
    if (input.outcome === 'succeeded' && !input.metadata) {
      throw new Error('Succeeded Memory extraction effect requires metadata')
    }
    const metadata = input.metadata
      ? {
          provider: identifier(input.metadata.provider, 'metadata.provider'),
          model: identifier(input.metadata.model, 'metadata.model'),
          requestId: input.metadata.requestId
            ? identifier(input.metadata.requestId, 'metadata.requestId', 512)
            : null,
          responseId: input.metadata.responseId
            ? identifier(input.metadata.responseId, 'metadata.responseId', 512)
            : null,
          usage: normalizeUsage(input.metadata.usage),
          cost: normalizeCost(input.metadata.cost),
          latencyMs: nonnegativeInteger(input.metadata.latencyMs, 'metadata.latencyMs'),
        }
      : null
    const resultFingerprint = fingerprintEffectRequest({
      outcome: input.outcome,
      ...(metadata ? {
        provider: metadata.provider,
        model: metadata.model,
        requestId: metadata.requestId,
        responseId: metadata.responseId,
        usage: metadata.usage,
        cost: metadata.cost,
        latencyMs: metadata.latencyMs,
      } : {}),
      ...(error ?? {}),
    })

    return this.db.transaction(async (tx) => {
      const active = await this.activeTask(tx, input)
      if (!active) return { status: 'lease_lost' as const }
      const [effect] = await tx
        .select()
        .from(memoryExtractionEffects)
        .where(and(
          eq(memoryExtractionEffects.sourceId, input.sourceId),
          eq(memoryExtractionEffects.attemptId, input.attemptId),
          eq(memoryExtractionEffects.effectKey, effectKey),
        ))
        .limit(1)
      if (!effect) throw new Error(`Memory extraction effect is not reserved: ${effectKey}`)
      if (metadata && (metadata.provider !== effect.provider || metadata.model !== effect.model)) {
        throw new Error(`Memory extraction provider identity collision: ${effectKey}`)
      }
      if (effect.budgetDay && input.outcome === 'succeeded') {
        if (!metadata?.cost) {
          throw new Error(`Budgeted Memory extraction effect requires metered cost: ${effectKey}`)
        }
        if (metadata.cost.pricingVersion !== effect.reservationPricingVersion) {
          throw new Error(`Memory extraction pricing snapshot collision: ${effectKey}`)
        }
        if (metadata.cost.microusd > (effect.reservedCostMicrousd ?? -1)) {
          throw new Error(`Memory extraction cost exceeded its reservation: ${effectKey}`)
        }
      }
      if (effect.status !== 'reserved') {
        if (effect.status === input.outcome && effect.resultFingerprint === resultFingerprint) {
          return { status: 'replayed' as const, effect }
        }
        throw new Error(`Memory extraction effect result collision: ${effectKey}`)
      }
      const [finished] = await tx
        .update(memoryExtractionEffects)
        .set({
          status: input.outcome,
          resultFingerprint,
          providerRequestId: metadata?.requestId ?? null,
          providerResponseId: metadata?.responseId ?? null,
          inputTokens: metadata?.usage?.inputTokens ?? null,
          outputTokens: metadata?.usage?.outputTokens ?? null,
          cacheReadInputTokens: metadata?.usage?.cacheReadInputTokens ?? null,
          cacheWriteInputTokens: metadata?.usage?.cacheWriteInputTokens ?? null,
          costMicrousd: metadata?.cost?.microusd ?? null,
          pricingVersion: metadata?.cost?.pricingVersion ?? null,
          costCurrency: metadata?.cost?.currency ?? null,
          latencyMs: metadata?.latencyMs ?? null,
          errorCode: error?.errorCode ?? null,
          errorMessage: error?.errorMessage ?? null,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryExtractionEffects.id, effect.id))
        .returning()
      if (!finished) throw new Error('Memory extraction effect finish failed')
      return { status: 'finished' as const, effect: finished }
    })
  }

  async completeExtraction(
    identity: MemoryExtractionLeaseIdentity,
    result: MemoryExtractionCompletionMetadata,
  ) {
    const metadata = normalizeCompletion(result)
    return this.db.transaction(async (tx) => {
      const active = await this.activeTask(tx, identity)
      if (!active) return { status: 'lease_lost' as const }
      const effects = await tx
        .select({ status: memoryExtractionEffects.status })
        .from(memoryExtractionEffects)
        .where(eq(memoryExtractionEffects.attemptId, identity.attemptId))
      if (effects.length !== 1 || effects[0]?.status !== 'succeeded') {
        throw new Error('Memory extraction cannot complete without one succeeded provider effect')
      }
      await tx
        .update(memoryExtractionAttempts)
        .set({
          status: 'completed',
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryExtractionAttempts.id, identity.attemptId))
      const [task] = await tx
        .update(memoryExtractionTasks)
        .set({
          status: 'completed',
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          resultMetadata: metadata,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryExtractionTasks.sourceId, identity.sourceId))
        .returning()
      if (!task) throw new Error('Memory extraction completion failed')
      return { status: 'completed' as const, task }
    })
  }

  async failExtraction(input: FailMemoryExtractionClaimInput) {
    const maxAttempts = positiveInteger(input.maxAttempts, 'maxAttempts')
    const requestedError = terminalError(input.errorCode, input.errorMessage)
    return this.db.transaction(async (tx) => {
      const active = await this.activeTask(tx, input)
      if (!active) return { status: 'lease_lost' as const }
      const effects = await tx
        .select()
        .from(memoryExtractionEffects)
        .where(eq(memoryExtractionEffects.attemptId, input.attemptId))
      const unsafe = effects.some((effect) =>
        effect.status === 'reserved' || effect.status === 'succeeded' || effect.status === 'uncertain')
      const outcome = input.outcome === 'uncertain' || unsafe ? 'uncertain' as const : 'failed' as const
      const error = outcome === 'uncertain' && input.outcome !== 'uncertain'
        ? terminalError(
            'provider_effect_uncertain',
            'Memory extraction failed after the provider effect may have succeeded.',
          )
        : requestedError
      if (outcome === 'uncertain') {
        const resultFingerprint = fingerprintEffectRequest({
          outcome: 'uncertain',
          errorCode: error.errorCode,
          errorMessage: error.errorMessage,
        })
        await tx
          .update(memoryExtractionEffects)
          .set({
            status: 'uncertain',
            resultFingerprint,
            ...error,
            finishedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(
            eq(memoryExtractionEffects.attemptId, input.attemptId),
            eq(memoryExtractionEffects.status, 'reserved'),
          ))
      }
      await tx
        .update(memoryExtractionAttempts)
        .set({
          status: outcome,
          ...error,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(memoryExtractionAttempts.id, input.attemptId))

      const shouldRetry = outcome === 'failed' && input.retryable && active.task.attempt < maxAttempts
      const [task] = await tx
        .update(memoryExtractionTasks)
        .set(shouldRetry
          ? {
              status: 'queued',
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              errorCode: null,
              errorMessage: null,
              finishedAt: null,
              updatedAt: sql`clock_timestamp()`,
            }
          : {
              status: outcome,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              ...error,
              finishedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
        .where(eq(memoryExtractionTasks.sourceId, input.sourceId))
        .returning()
      if (!task) throw new Error('Memory extraction failure settlement failed')
      return { status: shouldRetry ? 'retry_queued' as const : outcome, task }
    })
  }

  async getExtractionLedger(source: MemorySourcePointer) {
    const sourceId = source.kind === 'run' ? source.runId : source.signalId
    const [task] = await this.db
      .select()
      .from(memoryExtractionTasks)
      .where(and(
        eq(memoryExtractionTasks.sourceId, sourceId),
        eq(memoryExtractionTasks.sourceKind, source.kind),
      ))
      .limit(1)
    if (!task) return null
    const attempts = await this.db
      .select()
      .from(memoryExtractionAttempts)
      .where(eq(memoryExtractionAttempts.sourceId, sourceId))
      .orderBy(asc(memoryExtractionAttempts.attempt))
    const attemptIds = attempts.map((attempt) => attempt.id)
    const effects = attemptIds.length === 0
      ? []
      : await this.db
          .select()
          .from(memoryExtractionEffects)
          .where(inArray(memoryExtractionEffects.attemptId, attemptIds))
          .orderBy(asc(memoryExtractionEffects.createdAt))
    return { task, attempts, effects }
  }
}

export function createMemoryExtractionRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new MemoryExtractionRepository(db)
}
