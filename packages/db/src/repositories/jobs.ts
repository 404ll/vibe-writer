import { createHash, randomUUID } from 'node:crypto'
import {
  CreateJobRequestSchema,
  type CreateJobRequestInput,
} from '@vibe-writer/contracts/jobs'
import {
  JobEventSchema,
  type JobEvent,
} from '@vibe-writer/contracts/jobs/events'
import { TERMINAL_EVENTS } from '@vibe-writer/contracts/jobs/event-types'
import { and, asc, eq, gt, inArray, isNull, lte, max, or, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  TERMINAL_JOB_STATUSES,
  type CancellationRequestResult,
  type ClaimSettlement,
  type JobStatus,
  type LeaseHeartbeatResult,
  type ModelProfileSnapshot,
  type RunEffectType,
  type SettleClaimResult,
  type ToolVersions,
} from '../domain'
import * as schema from '../schema'
import {
  jobEvents,
  jobInterrupts,
  jobs,
  outboxEvents,
  runEffects,
  runs,
  traceSpans,
} from '../schema'

const ALLOWED_JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['cancelled', 'failed'],
  running: [],
  awaiting_input: ['failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export type VibeDatabase<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  typeof schema
>

export type CreateDurableJobInput = CreateJobRequestInput & {
  workspaceId: string
  createdByPrincipalId: string
  idempotencyKey: string
  jobId?: string
}

export type CreateRunInput = {
  jobId: string
  attempt: number
  modelProfile: ModelProfileSnapshot
  promptVersion: string
  graphVersion: string
  toolVersions: ToolVersions
  codeRevision: string
}

export type RunExecutionSnapshot = Omit<CreateRunInput, 'jobId' | 'attempt'>

export type ClaimJobInput = {
  jobId: string
  workerId: string
  leaseDurationMs: number
  execution: RunExecutionSnapshot
}

export type LeaseIdentity = {
  jobId: string
  runId: string
  leaseToken: string
}

export type SettleClaimInput = LeaseIdentity & {
  outcome: ClaimSettlement
  errorCode?: string
  errorMessage?: string
}

export type AppendRunEventInput = LeaseIdentity & {
  idempotencyKey: string
  event: JobEvent
}

export type AppendRunEventResult =
  | { status: 'appended' | 'replayed'; event: JobEvent }
  | { status: 'cancel_requested' | 'lease_lost' }

export type ReserveRunEffectInput = LeaseIdentity & {
  effectKey: string
  effectType: RunEffectType
  requestFingerprint: string
  trace?: {
    operation: string
    parentSpanKey?: string
    attributes?: CanonicalJsonObject
  }
}

export type ReserveRunEffectResult =
  | {
      status:
        | 'reserved'
        | 'already_reserved'
        | 'previously_succeeded'
        | 'previous_failed'
        | 'uncertain'
      effect: schema.RunEffectRow
    }
  | { status: 'cancel_requested' | 'lease_lost' }

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | CanonicalJsonObject

export type CanonicalJsonObject = { [key: string]: CanonicalJsonValue }

export type FinishRunEffectInput = LeaseIdentity & {
  effectKey: string
  outcome: 'succeeded' | 'failed'
  resultMetadata?: CanonicalJsonObject
  errorCode?: string
  errorMessage?: string
}

export type FinishRunEffectResult =
  | { status: 'finished' | 'replayed'; effect: schema.RunEffectRow }
  | { status: 'cancel_requested' | 'lease_lost' | 'not_found' | 'not_owner' }

const MAX_ERROR_LENGTH = 1_000
const MAX_EFFECT_KEY_LENGTH = 512
const MAX_EFFECT_METADATA_BYTES = 16_384
const MAX_TRACE_ATTRIBUTES_BYTES = 4_096

function boundedError(value: string | undefined): string | null {
  return value ? value.slice(0, MAX_ERROR_LENGTH) : null
}

function requireBoundedIdentifier(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} non-whitespace characters`)
  }
  return normalized
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON requires finite numbers')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new Error(`Canonical JSON does not support ${typeof value}`)
  }
  if (ancestors.has(value)) throw new Error('Canonical JSON does not support cycles')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error('Canonical JSON does not support sparse arrays')
        }
        items.push(stableJson(value[index], ancestors))
      }
      const extraKeys = Reflect.ownKeys(value).filter(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)),
      )
      if (extraKeys.length > 0) {
        throw new Error('Canonical JSON arrays cannot have extra properties')
      }
      return `[${items.join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Canonical JSON only supports plain objects')
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new Error('Canonical JSON objects require string keys')
    }
    const record = value as Record<string, unknown>
    const keys = ownKeys as string[]
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error('Canonical JSON objects require enumerable data properties')
      }
    }
    return `{${keys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function fingerprintEffectRequest(value: CanonicalJsonValue): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function eventFingerprint(eventType: string, eventData: unknown): string {
  return createHash('sha256')
    .update(`${eventType}\n${stableJson(eventData)}`)
    .digest('hex')
}

function boundedEffectMetadata(
  value: CanonicalJsonObject | undefined,
): CanonicalJsonObject | null {
  if (!value) return null
  const serialized = stableJson(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EFFECT_METADATA_BYTES) {
    throw new Error(`Effect result metadata exceeds ${MAX_EFFECT_METADATA_BYTES} bytes`)
  }
  return value
}

function boundedTraceAttributes(
  value: CanonicalJsonObject | undefined,
): CanonicalJsonObject | null {
  if (!value) return null
  const serialized = stableJson(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TRACE_ATTRIBUTES_BYTES) {
    throw new Error(`Trace attributes exceed ${MAX_TRACE_ATTRIBUTES_BYTES} bytes`)
  }
  return value
}

function traceSpanKind(effectType: RunEffectType) {
  if (effectType === 'model_call') return 'model' as const
  if (effectType === 'search') return 'search' as const
  if (effectType === 'tool_call') return 'tool' as const
  return 'workflow' as const
}

function metadataString(metadata: CanonicalJsonObject | null, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.slice(0, 512) : null
}

function metadataInteger(metadata: CanonicalJsonObject | null, key: string): number | null {
  const value = metadata?.[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function traceResult(metadata: CanonicalJsonObject | null) {
  const usage = metadata?.usage
  const usageRecord =
    usage && typeof usage === 'object' && !Array.isArray(usage)
      ? usage as CanonicalJsonObject
      : null
  const attributes: CanonicalJsonObject = {}
  for (const key of ['finishReason', 'stopReason', 'documentCount'] as const) {
    const value = metadata?.[key]
    if (value !== undefined) attributes[key] = value
  }
  return {
    provider: metadataString(metadata, 'provider'),
    model: metadataString(metadata, 'model'),
    providerRequestId: metadataString(metadata, 'requestId'),
    providerResponseId: metadataString(metadata, 'responseId'),
    inputTokens: metadataInteger(usageRecord, 'inputTokens'),
    outputTokens: metadataInteger(usageRecord, 'outputTokens'),
    cacheReadInputTokens: metadataInteger(usageRecord, 'cacheReadInputTokens'),
    cacheWriteInputTokens: metadataInteger(usageRecord, 'cacheWriteInputTokens'),
    latencyMs: metadataInteger(metadata, 'latencyMs'),
    attributes: Object.keys(attributes).length ? attributes : null,
  }
}

function assertClaimInput(input: ClaimJobInput) {
  if (!input.workerId.trim()) throw new Error('workerId is required')
  if (!Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
    throw new Error('leaseDurationMs must be a positive integer')
  }
  const versionFields = [
    input.execution.promptVersion,
    input.execution.graphVersion,
    input.execution.codeRevision,
    input.execution.modelProfile.profile,
    input.execution.modelProfile.provider,
    input.execution.modelProfile.model,
    ...Object.values(input.execution.toolVersions),
  ]
  if (
    Object.keys(input.execution.toolVersions).length === 0 ||
    versionFields.some(
      (value) => !value.trim() || value.trim() === 'prototype-unbound',
    )
  ) {
    throw new Error('Claim execution metadata must contain bound, non-empty versions')
  }
}

export class JobRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async createJob(input: CreateDurableJobInput) {
    const request = CreateJobRequestSchema.parse(input)
    const jobId = input.jobId ?? randomUUID()

    // 任务是业务事实，事务发件箱是“这个事实需要被异步处理”的持久化意图。
    // 两者必须同事务提交，否则进程可能在写入任务后、发布队列前崩溃，留下永远不执行的任务。
    return this.db.transaction(async (tx) => {
      const [createdJob] = await tx
        .insert(jobs)
        .values({
          id: jobId,
          workspaceId: input.workspaceId,
          createdByPrincipalId: input.createdByPrincipalId,
          idempotencyKey: input.idempotencyKey,
          topic: request.topic,
          style: request.style,
          targetWords: request.target_words ?? null,
          intervention: request.intervention,
        })
        .onConflictDoNothing({ target: [jobs.workspaceId, jobs.idempotencyKey] })
        .returning()

      if (!createdJob) {
        const [existingJob] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.workspaceId, input.workspaceId),
              eq(jobs.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)

        if (!existingJob) {
          throw new Error(`Idempotent job lookup failed for ${input.idempotencyKey}`)
        }

        return { job: existingJob, created: false }
      }

      await tx.insert(outboxEvents).values({
        idempotencyKey: `job:${createdJob.id}:enqueue:v1`,
        aggregateType: 'job',
        aggregateId: createdJob.id,
        eventType: 'job.enqueue.requested',
        payload: { jobId: createdJob.id },
      })

      return { job: createdJob, created: true }
    })
  }

  async getJob(jobId: string) {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    return job ?? null
  }

  async getJobForWorkspace(jobId: string, workspaceId: string) {
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId)))
      .limit(1)
    return job ?? null
  }

  async transitionJob(jobId: string, expected: JobStatus, next: JobStatus) {
    if (!ALLOWED_JOB_TRANSITIONS[expected].includes(next)) return null

    const now = new Date()
    const terminal = TERMINAL_JOB_STATUSES.has(next)
    const [updated] = await this.db
      .update(jobs)
      .set({
        status: next,
        startedAt: expected === 'queued' && next === 'running' ? now : undefined,
        finishedAt: terminal ? now : null,
        updatedAt: now,
        version: sql`${jobs.version} + 1`,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, expected)))
      .returning()

    return updated ?? null
  }

  async claimJob(input: ClaimJobInput) {
    assertClaimInput(input)
    const leaseToken = randomUUID()
    const leaseExpiry = sql<Date>`clock_timestamp() + (${input.leaseDurationMs} * interval '1 millisecond')`

    // BullMQ 的锁只保护一条 Redis 消息；数据库租约才保护业务任务。
    // 新的 `leaseToken` 是隔离令牌：旧工作进程即使稍后恢复，也无法再写事件或终态。
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .update(jobs)
        .set({
          status: 'running',
          leaseOwner: input.workerId,
          leaseToken,
          leaseExpiresAt: leaseExpiry,
          heartbeatAt: sql`clock_timestamp()`,
          startedAt: sql`coalesce(${jobs.startedAt}, clock_timestamp())`,
          errorCode: null,
          errorMessage: null,
          updatedAt: sql`clock_timestamp()`,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, input.jobId),
            isNull(jobs.cancelRequestedAt),
            or(
              eq(jobs.status, 'queued'),
              and(
                eq(jobs.status, 'running'),
                lte(jobs.leaseExpiresAt, sql`clock_timestamp()`),
              ),
            ),
          ),
        )
        .returning()

      if (!job) return null
      if (!job.leaseExpiresAt || !job.heartbeatAt) {
        throw new Error(`Claimed job ${job.id} is missing lease timestamps`)
      }
      const claimLeaseExpiresAt = sql<Date>`(
        select ${jobs.leaseExpiresAt} from ${jobs} where ${jobs.id} = ${job.id}
      )`
      const claimTime = sql<Date>`(
        select ${jobs.heartbeatAt} from ${jobs} where ${jobs.id} = ${job.id}
      )`

      await tx
        .update(runEffects)
        .set({
          status: 'uncertain',
          errorCode: 'lease_takeover',
          errorMessage: 'The owning run lost its lease before the effect settled.',
          finishedAt: claimTime,
          updatedAt: claimTime,
        })
        .where(and(eq(runEffects.jobId, job.id), eq(runEffects.status, 'reserved')))

      await tx
        .update(traceSpans)
        .set({
          status: 'uncertain',
          errorCode: 'lease_takeover',
          errorMessage: 'The owning run lost its lease before the span settled.',
          finishedAt: claimTime,
          updatedAt: claimTime,
        })
        .where(and(eq(traceSpans.jobId, job.id), eq(traceSpans.status, 'running')))

      await tx
        .update(runs)
        .set({
          status: 'failed',
          errorCode: 'lease_expired',
          errorMessage: 'Worker lease expired before the run settled.',
          finishedAt: claimTime,
          updatedAt: claimTime,
        })
        .where(and(eq(runs.jobId, job.id), eq(runs.status, 'running')))

      const [attemptRow] = await tx
        .select({ value: max(runs.attempt) })
        .from(runs)
        .where(eq(runs.jobId, job.id))
      const attempt = (attemptRow?.value ?? 0) + 1

      const [run] = await tx
        .insert(runs)
        .values({
          ...input.execution,
          jobId: job.id,
          attempt,
          status: 'running',
          workerId: input.workerId,
          leaseToken,
          leaseExpiresAt: claimLeaseExpiresAt,
          heartbeatAt: claimTime,
          startedAt: claimTime,
        })
        .returning()

      if (!run) throw new Error(`Run creation failed for claimed job ${job.id}`)

      return { job, run, leaseToken }
    })
  }

  async heartbeatClaim(
    identity: LeaseIdentity,
    leaseDurationMs: number,
  ): Promise<LeaseHeartbeatResult> {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive integer')
    }
    const leaseExpiry = sql<Date>`clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`

    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .update(jobs)
        .set({
          leaseExpiresAt: leaseExpiry,
          heartbeatAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, identity.jobId),
            eq(jobs.status, 'running'),
            eq(jobs.leaseToken, identity.leaseToken),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
            isNull(jobs.cancelRequestedAt),
          ),
        )
        .returning({
          id: jobs.id,
          leaseExpiresAt: jobs.leaseExpiresAt,
          heartbeatAt: jobs.heartbeatAt,
        })

      if (!job) {
        const [current] = await tx
          .select({ cancelRequestedAt: jobs.cancelRequestedAt })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, identity.jobId),
              eq(jobs.status, 'running'),
              eq(jobs.leaseToken, identity.leaseToken),
            ),
          )
          .limit(1)
        return current?.cancelRequestedAt ? 'cancel_requested' : 'lease_lost'
      }
      if (!job.leaseExpiresAt || !job.heartbeatAt) {
        throw new Error(`Heartbeat for job ${identity.jobId} is missing lease timestamps`)
      }
      const heartbeatLeaseExpiresAt = sql<Date>`(
        select ${jobs.leaseExpiresAt} from ${jobs} where ${jobs.id} = ${identity.jobId}
      )`
      const heartbeatTime = sql<Date>`(
        select ${jobs.heartbeatAt} from ${jobs} where ${jobs.id} = ${identity.jobId}
      )`

      const [run] = await tx
        .update(runs)
        .set({
          leaseExpiresAt: heartbeatLeaseExpiresAt,
          heartbeatAt: heartbeatTime,
          updatedAt: heartbeatTime,
        })
        .where(
          and(
            eq(runs.id, identity.runId),
            eq(runs.jobId, identity.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, identity.leaseToken),
          ),
        )
        .returning({ id: runs.id })

      if (!run) throw new Error(`Active run missing for claimed job ${identity.jobId}`)
      return 'renewed'
    })
  }

  async settleClaim(input: SettleClaimInput): Promise<
    | (SettleClaimResult & { status: 'settled'; job: schema.JobRow; run: schema.RunRow })
    | Exclude<SettleClaimResult, { status: 'settled' }>
  > {
    const errorCode = input.outcome === 'failed' ? boundedError(input.errorCode) : null
    const errorMessage = input.outcome === 'failed' ? boundedError(input.errorMessage) : null

    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .update(jobs)
        .set({
          status: input.outcome,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          errorCode,
          errorMessage,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, 'running'),
            eq(jobs.leaseToken, input.leaseToken),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
            input.outcome === 'cancelled' ? sql`true` : isNull(jobs.cancelRequestedAt),
          ),
        )
        .returning()

      if (!job) {
        const [current] = await tx
          .select({ cancelRequestedAt: jobs.cancelRequestedAt })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, input.jobId),
              eq(jobs.status, 'running'),
              eq(jobs.leaseToken, input.leaseToken),
            ),
          )
          .limit(1)
        return current?.cancelRequestedAt && input.outcome !== 'cancelled'
          ? { status: 'cancel_requested' as const }
          : { status: 'lease_lost' as const }
      }
      if (!job.finishedAt) {
        throw new Error(`Settled job ${input.jobId} is missing finishedAt`)
      }
      const settledAt = sql<Date>`(
        select ${jobs.finishedAt} from ${jobs} where ${jobs.id} = ${input.jobId}
      )`

      await tx
        .update(runEffects)
        .set({
          status: 'uncertain',
          errorCode: 'run_terminal_with_reserved_effect',
          errorMessage: 'The run terminated before the effect outcome was recorded.',
          finishedAt: settledAt,
          updatedAt: settledAt,
        })
        .where(
          and(
            eq(runEffects.jobId, input.jobId),
            eq(runEffects.runId, input.runId),
            eq(runEffects.status, 'reserved'),
          ),
        )

      await tx
        .update(traceSpans)
        .set({
          status: 'uncertain',
          errorCode: 'run_terminal_with_running_span',
          errorMessage: 'The run terminated before the trace span settled.',
          finishedAt: settledAt,
          updatedAt: settledAt,
        })
        .where(
          and(
            eq(traceSpans.jobId, input.jobId),
            eq(traceSpans.runId, input.runId),
            eq(traceSpans.status, 'running'),
          ),
        )

      const [run] = await tx
        .update(runs)
        .set({
          status: input.outcome,
          errorCode,
          errorMessage,
          finishedAt: settledAt,
          updatedAt: settledAt,
        })
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.jobId, input.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, input.leaseToken),
          ),
        )
        .returning()

      if (!run) throw new Error(`Active run missing for claimed job ${input.jobId}`)
      return { status: 'settled' as const, job, run }
    })
  }

  async requestCancellation(jobId: string): Promise<CancellationRequestResult> {
    return this.requestCancellationWithinWorkspace(jobId)
  }

  async requestCancellationForWorkspace(
    jobId: string,
    workspaceId: string,
  ): Promise<CancellationRequestResult> {
    return this.requestCancellationWithinWorkspace(jobId, workspaceId)
  }

  private async requestCancellationWithinWorkspace(
    jobId: string,
    workspaceId?: string,
  ): Promise<CancellationRequestResult> {
    // 未执行或已暂停的任务没有活跃 Worker，可直接提交 cancelled 终态；
    // running 任务只能先记录 cancelRequestedAt，由 Worker 心跳转成 AbortSignal 后收敛。
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(jobs)
        .where(
          workspaceId
            ? and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId))
            : eq(jobs.id, jobId),
        )
        .for('update')
        .limit(1)
      if (!current) return 'not_found'
      if (TERMINAL_JOB_STATUSES.has(current.status)) return 'already_terminal'

      if (current.status === 'queued' || current.status === 'awaiting_input') {
        const cancelledAt = sql<Date>`clock_timestamp()`
        const eventData = {}
        await tx.insert(jobEvents).values({
          jobId,
          seq: current.nextEventSeq,
          idempotencyKey: `job:${jobId}:terminal:cancelled:v1`,
          payloadFingerprint: eventFingerprint('cancelled', eventData),
          eventType: 'cancelled',
          eventData,
        })
        if (current.status === 'awaiting_input') {
          await tx
            .update(jobInterrupts)
            .set({ status: 'cancelled', updatedAt: cancelledAt })
            .where(
              and(
                eq(jobInterrupts.jobId, jobId),
                eq(jobInterrupts.status, 'pending'),
              ),
            )
        }
        const [cancelled] = await tx
          .update(jobs)
          .set({
            status: 'cancelled',
            nextEventSeq: current.nextEventSeq + 1,
            cancelRequestedAt: cancelledAt,
            finishedAt: cancelledAt,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            updatedAt: cancelledAt,
            version: sql`${jobs.version} + 1`,
          })
          .where(
            and(
              eq(jobs.id, jobId),
              inArray(jobs.status, ['queued', 'awaiting_input']),
            ),
          )
          .returning({ id: jobs.id })
        if (!cancelled) throw new Error(`Cancellation state changed for ${jobId}`)
        return 'cancelled'
      }

      const [requested] = await tx
        .update(jobs)
        .set({
          cancelRequestedAt: sql`coalesce(${jobs.cancelRequestedAt}, clock_timestamp())`,
          updatedAt: sql`clock_timestamp()`,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'running'),
            isNull(jobs.cancelRequestedAt),
          ),
        )
        .returning({ id: jobs.id })
      if (requested) return 'cancel_requested'
      return 'cancel_requested'
    })
  }

  async getRun(runId: string) {
    const [run] = await this.db.select().from(runs).where(eq(runs.id, runId)).limit(1)
    return run ?? null
  }

  async appendRunEvent(input: AppendRunEventInput): Promise<AppendRunEventResult> {
    const idempotencyKey = requireBoundedIdentifier(
      input.idempotencyKey,
      'idempotencyKey',
      MAX_EFFECT_KEY_LENGTH,
    )
    const parsed = JobEventSchema.parse(input.event)
    if (TERMINAL_EVENTS.has(parsed.event)) {
      throw new Error('Terminal events must be committed with the terminal job transaction')
    }
    const eventData = { ...parsed.data }
    delete eventData._seq
    const payloadFingerprint = eventFingerprint(parsed.event, eventData)

    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select({ id: jobs.id, cancelRequestedAt: jobs.cancelRequestedAt })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, 'running'),
            eq(jobs.leaseToken, input.leaseToken),
          ),
        )
        .for('update')
        .limit(1)

      if (!job) return { status: 'lease_lost' as const }
      const [activeLease] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.leaseToken, input.leaseToken),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1)
      if (!activeLease) return { status: 'lease_lost' as const }
      if (job.cancelRequestedAt) return { status: 'cancel_requested' as const }

      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.jobId, input.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, input.leaseToken),
          ),
        )
        .limit(1)
      if (!run) throw new Error(`Active run missing for claimed job ${input.jobId}`)

      const [existing] = await tx
        .select()
        .from(jobEvents)
        .where(
          and(
            eq(jobEvents.jobId, input.jobId),
            eq(jobEvents.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
      if (existing) {
        if (existing.payloadFingerprint !== payloadFingerprint) {
          throw new Error(`Event idempotency collision: ${idempotencyKey}`)
        }
        return {
          status: 'replayed' as const,
          event: JobEventSchema.parse({
            event: existing.eventType,
            data: { ...existing.eventData, _seq: existing.seq },
          }),
        }
      }

      const [cursor] = await tx
        .update(jobs)
        .set({
          nextEventSeq: sql`${jobs.nextEventSeq} + 1`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(jobs.id, input.jobId))
        .returning({ nextEventSeq: jobs.nextEventSeq })
      if (!cursor) throw new Error(`Job not found: ${input.jobId}`)

      const seq = cursor.nextEventSeq - 1
      await tx.insert(jobEvents).values({
        jobId: input.jobId,
        seq,
        runId: input.runId,
        idempotencyKey,
        payloadFingerprint,
        eventType: parsed.event,
        eventData,
      })

      return {
        status: 'appended' as const,
        event: JobEventSchema.parse({
          event: parsed.event,
          data: { ...eventData, _seq: seq },
        }),
      }
    })
  }

  async reserveRunEffect(input: ReserveRunEffectInput): Promise<ReserveRunEffectResult> {
    const effectKey = requireBoundedIdentifier(
      input.effectKey,
      'effectKey',
      MAX_EFFECT_KEY_LENGTH,
    )
    const requestFingerprint = requireBoundedIdentifier(
      input.requestFingerprint,
      'requestFingerprint',
      256,
    )
    if (!/^sha256:[0-9a-f]{64}$/.test(requestFingerprint)) {
      throw new Error('requestFingerprint must be a canonical sha256 fingerprint')
    }
    const operation = requireBoundedIdentifier(
      input.trace?.operation ?? effectKey,
      'trace.operation',
      256,
    )
    const parentSpanKey = input.trace?.parentSpanKey
      ? requireBoundedIdentifier(input.trace.parentSpanKey, 'trace.parentSpanKey', MAX_EFFECT_KEY_LENGTH)
      : null
    const traceAttributes = boundedTraceAttributes(input.trace?.attributes)

    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select({ id: jobs.id, cancelRequestedAt: jobs.cancelRequestedAt })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, 'running'),
            eq(jobs.leaseToken, input.leaseToken),
          ),
        )
        .for('update')
        .limit(1)
      if (!job) return { status: 'lease_lost' as const }
      const [activeLease] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.leaseToken, input.leaseToken),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1)
      if (!activeLease) return { status: 'lease_lost' as const }
      if (job.cancelRequestedAt) return { status: 'cancel_requested' as const }

      const [run] = await tx
        .select({ id: runs.id, traceId: runs.traceId })
        .from(runs)
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.jobId, input.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, input.leaseToken),
          ),
        )
        .limit(1)
      if (!run) throw new Error(`Active run missing for claimed job ${input.jobId}`)

      const [existing] = await tx
        .select()
        .from(runEffects)
        .where(
          and(
            eq(runEffects.jobId, input.jobId),
            eq(runEffects.effectKey, effectKey),
          ),
        )
        .limit(1)
      if (existing) {
        if (
          existing.effectType !== input.effectType ||
          existing.requestFingerprint !== requestFingerprint
        ) {
          throw new Error(`Effect idempotency collision: ${effectKey}`)
        }
        if (existing.status === 'succeeded') {
          return { status: 'previously_succeeded' as const, effect: existing }
        }
        if (existing.status === 'failed') {
          return { status: 'previous_failed' as const, effect: existing }
        }
        if (existing.status === 'uncertain' || existing.runId !== input.runId) {
          return { status: 'uncertain' as const, effect: existing }
        }
        return { status: 'already_reserved' as const, effect: existing }
      }

      const [effect] = await tx
        .insert(runEffects)
        .values({
          jobId: input.jobId,
          runId: input.runId,
          effectKey,
          effectType: input.effectType,
          requestFingerprint,
        })
        .returning()
      if (!effect) throw new Error(`Effect reservation failed: ${effectKey}`)
      await tx.insert(traceSpans).values({
        traceId: run.traceId,
        jobId: input.jobId,
        runId: input.runId,
        spanKey: effectKey,
        parentSpanKey,
        spanKind: traceSpanKind(input.effectType),
        operation,
        requestFingerprint,
        attributes: traceAttributes,
      })
      return { status: 'reserved' as const, effect }
    })
  }

  async finishRunEffect(input: FinishRunEffectInput): Promise<FinishRunEffectResult> {
    const effectKey = requireBoundedIdentifier(
      input.effectKey,
      'effectKey',
      MAX_EFFECT_KEY_LENGTH,
    )
    const resultMetadata =
      input.outcome === 'succeeded' ? boundedEffectMetadata(input.resultMetadata) : null
    const errorCode = input.outcome === 'failed' ? boundedError(input.errorCode) : null
    const errorMessage = input.outcome === 'failed' ? boundedError(input.errorMessage) : null

    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select({ id: jobs.id, cancelRequestedAt: jobs.cancelRequestedAt })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, 'running'),
            eq(jobs.leaseToken, input.leaseToken),
          ),
        )
        .for('update')
        .limit(1)
      if (!job) return { status: 'lease_lost' as const }
      const [activeLease] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.leaseToken, input.leaseToken),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1)
      if (!activeLease) return { status: 'lease_lost' as const }
      if (job.cancelRequestedAt) return { status: 'cancel_requested' as const }

      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.jobId, input.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, input.leaseToken),
          ),
        )
        .limit(1)
      if (!run) throw new Error(`Active run missing for claimed job ${input.jobId}`)

      const [effect] = await tx
        .select()
        .from(runEffects)
        .where(
          and(
            eq(runEffects.jobId, input.jobId),
            eq(runEffects.effectKey, effectKey),
          ),
        )
        .limit(1)
      if (!effect) return { status: 'not_found' as const }
      if (effect.runId !== input.runId) return { status: 'not_owner' as const }
      if (effect.status === input.outcome) {
        return { status: 'replayed' as const, effect }
      }
      if (effect.status !== 'reserved') return { status: 'not_owner' as const }

      const [finished] = await tx
        .update(runEffects)
        .set({
          status: input.outcome,
          resultMetadata,
          errorCode,
          errorMessage,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(runEffects.id, effect.id),
            eq(runEffects.runId, input.runId),
            eq(runEffects.status, 'reserved'),
          ),
        )
        .returning()
      if (!finished) return { status: 'not_owner' as const }
      const traceMetadata = traceResult(resultMetadata)
      const [finishedSpan] = await tx
        .update(traceSpans)
        .set({
          status: input.outcome,
          ...traceMetadata,
          errorCode,
          errorMessage,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(traceSpans.jobId, input.jobId),
            eq(traceSpans.runId, input.runId),
            eq(traceSpans.spanKey, effectKey),
            eq(traceSpans.status, 'running'),
          ),
        )
        .returning({ id: traceSpans.id })
      if (!finishedSpan) {
        throw new Error(`Trace span missing for reserved effect ${effectKey}`)
      }
      return { status: 'finished' as const, effect: finished }
    })
  }

  async listEventsAfter(jobId: string, afterSeq = -1): Promise<JobEvent[]> {
    const rows = await this.db
      .select()
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.seq, afterSeq)))
      .orderBy(asc(jobEvents.seq))

    return rows.map((row) =>
      JobEventSchema.parse({
        event: row.eventType,
        data: { ...row.eventData, _seq: row.seq },
      }),
    )
  }

  async listEventsAfterForWorkspace(
    jobId: string,
    workspaceId: string,
    afterSeq = -1,
  ): Promise<JobEvent[] | null> {
    if (!(await this.getJobForWorkspace(jobId, workspaceId))) return null
    return this.listEventsAfter(jobId, afterSeq)
  }
}

export function createJobRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new JobRepository(db)
}
