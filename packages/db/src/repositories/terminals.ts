import { createHash } from 'node:crypto'
import { JobEventSchema, type JobEvent } from '@vibe-writer/contracts/jobs/events'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  articles,
  jobInterrupts,
  jobEvents,
  jobs,
  outboxEvents,
  runEffects,
  runs,
  traceSpans,
  type ArticleRow,
} from '../schema'
import type { LeaseIdentity, VibeDatabase } from './jobs'

const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024
const MAX_TOPIC_LENGTH = 10_000
const MAX_OUTPUT_PATH_LENGTH = 2_048
const MAX_IDEMPOTENCY_KEY_LENGTH = 512

export type CompleteClaimInput = LeaseIdentity & {
  exportIdempotencyKey: string
  topic: string
  markdown: string
  outputPath: string | null
  requestMemoryExtraction?: boolean
}

export type CompleteClaimResult =
  | {
      status: 'committed' | 'replayed'
      article: ArticleRow
      event: Extract<JobEvent, { event: 'done' }>
    }
  | { status: 'cancel_requested' | 'lease_lost' }

export type TerminateClaimInput = LeaseIdentity &
  (
    | { outcome: 'cancelled' }
    | { outcome: 'failed'; errorCode: string; errorMessage: string }
  )

export type TerminateClaimResult =
  | {
      status: 'settled' | 'replayed'
      event: Extract<JobEvent, { event: 'cancelled' | 'error' }>
    }
  | { status: 'cancel_requested' | 'lease_lost' }

export type PauseClaimInput = LeaseIdentity & {
  interruptId: string
  outline: string[]
}

export type PauseClaimResult =
  | {
      status: 'paused' | 'replayed'
      event: Extract<JobEvent, { event: 'outline_ready' }>
    }
  | { status: 'cancel_requested' | 'lease_lost' }

function requireText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} non-whitespace characters`)
  }
  return normalized
}

function contentFingerprint(markdown: string): string {
  return `sha256:${createHash('sha256').update(markdown).digest('hex')}`
}

function doneFingerprint(outputPath: string | null, articleId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ article_id: articleId, output_path: outputPath }))
    .digest('hex')
}

function eventFingerprint(eventType: string, eventData: unknown): string {
  return createHash('sha256')
    .update(`${eventType}\n${JSON.stringify(eventData)}`)
    .digest('hex')
}

function memoryExtractionOutbox(runId: string) {
  return {
    idempotencyKey: `run:${runId}:memory-extraction:v2`,
    aggregateType: 'memory_extraction',
    aggregateId: runId,
    eventType: 'memory.extraction.requested',
    payload: {
      schemaVersion: 2,
      source: { kind: 'run', runId },
    },
  }
}

function boundedError(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized.slice(0, 1_000)
}

function wordCount(markdown: string): number {
  return Array.from(markdown.replace(/\s/gu, '')).length
}

export class TerminalRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async completeClaim(input: CompleteClaimInput): Promise<CompleteClaimResult> {
    const exportIdempotencyKey = requireText(
      input.exportIdempotencyKey,
      'exportIdempotencyKey',
      MAX_IDEMPOTENCY_KEY_LENGTH,
    )
    const topic = requireText(input.topic, 'topic', MAX_TOPIC_LENGTH)
    if (!input.markdown.trim()) throw new Error('markdown is required')
    if (Buffer.byteLength(input.markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
      throw new Error(`markdown exceeds ${MAX_MARKDOWN_BYTES} bytes`)
    }
    if (input.outputPath !== null && input.outputPath.length > MAX_OUTPUT_PATH_LENGTH) {
      throw new Error(`outputPath exceeds ${MAX_OUTPUT_PATH_LENGTH} characters`)
    }
    const fingerprint = contentFingerprint(input.markdown)
    const terminalIdempotencyKey = `job:${input.jobId}:terminal:done:v1`

    // 文章、done 事件、Job 终态和 Run 终态共用一个事务。任何一步失败都会
    // 整体回滚，前端不会看到互相矛盾的“文章已存在 / 任务仍运行”状态。
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, input.jobId))
        .for('update')
        .limit(1)
      if (!job) return { status: 'lease_lost' as const }

      if (job.status === 'completed') {
        const [article] = await tx
          .select()
          .from(articles)
          .where(eq(articles.jobId, input.jobId))
          .limit(1)
        const [run] = await tx
          .select({ leaseToken: runs.leaseToken })
          .from(runs)
          .where(
            and(
              eq(runs.id, input.runId),
              eq(runs.jobId, input.jobId),
              eq(runs.status, 'completed'),
            ),
          )
          .limit(1)
        if (!article || run?.leaseToken !== input.leaseToken) {
          return { status: 'lease_lost' as const }
        }
        if (
          article.exportIdempotencyKey !== exportIdempotencyKey ||
          article.topic !== topic ||
          article.contentFingerprint !== fingerprint ||
          article.content !== input.markdown
        ) {
          throw new Error(`Terminal idempotency collision for ${input.jobId}`)
        }
        const [eventRow] = await tx
          .select()
          .from(jobEvents)
          .where(
            and(
              eq(jobEvents.jobId, input.jobId),
              eq(jobEvents.idempotencyKey, terminalIdempotencyKey),
            ),
          )
          .limit(1)
        if (!eventRow || eventRow.eventType !== 'done') {
          throw new Error(`Completed job ${input.jobId} is missing its done event`)
        }
        if (input.requestMemoryExtraction === true) {
          await tx.insert(outboxEvents)
            .values(memoryExtractionOutbox(input.runId))
            .onConflictDoNothing({ target: outboxEvents.idempotencyKey })
        }
        return {
          status: 'replayed' as const,
          article,
          event: JobEventSchema.parse({
            event: 'done',
            data: { ...eventRow.eventData, _seq: eventRow.seq },
          }) as Extract<JobEvent, { event: 'done' }>,
        }
      }

      if (
        job.status !== 'running' ||
        job.leaseToken !== input.leaseToken ||
        !job.leaseExpiresAt
      ) {
        return { status: 'lease_lost' as const }
      }
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
        .select()
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
      if (!run) return { status: 'lease_lost' as const }

      const [article] = await tx
        .insert(articles)
        .values({
          jobId: input.jobId,
          sourceRunId: input.runId,
          exportIdempotencyKey,
          topic,
          content: input.markdown,
          contentFingerprint: fingerprint,
          wordCount: wordCount(input.markdown),
          graphVersion: run.graphVersion,
          promptVersion: run.promptVersion,
          codeRevision: run.codeRevision,
        })
        .returning()
      if (!article) throw new Error(`Article creation failed for ${input.jobId}`)

      const seq = job.nextEventSeq
      const eventData = { output_path: input.outputPath, article_id: article.id }
      await tx.insert(jobEvents).values({
        jobId: input.jobId,
        seq,
        runId: input.runId,
        idempotencyKey: terminalIdempotencyKey,
        payloadFingerprint: doneFingerprint(input.outputPath, article.id),
        eventType: 'done',
        eventData,
      })

      const [completedJob] = await tx
        .update(jobs)
        .set({
          status: 'completed',
          stage: 'export',
          nextEventSeq: seq + 1,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          errorCode: null,
          errorMessage: null,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, 'running'),
            eq(jobs.leaseToken, input.leaseToken),
          ),
        )
        .returning({ finishedAt: jobs.finishedAt })
      if (!completedJob?.finishedAt) {
        throw new Error(`Job terminal update failed for ${input.jobId}`)
      }

      await tx
        .update(runEffects)
        .set({
          status: 'uncertain',
          errorCode: 'run_terminal_with_reserved_effect',
          errorMessage: 'The run completed before the effect outcome was recorded.',
          finishedAt: completedJob.finishedAt,
          updatedAt: completedJob.finishedAt,
        })
        .where(
          and(
            eq(runEffects.jobId, input.jobId),
            eq(runEffects.runId, input.runId),
            eq(runEffects.status, 'reserved'),
          ),
        )

      const [completedRun] = await tx
        .update(runs)
        .set({
          status: 'completed',
          errorCode: null,
          errorMessage: null,
          finishedAt: completedJob.finishedAt,
          updatedAt: completedJob.finishedAt,
        })
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.jobId, input.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: runs.id })
      if (!completedRun) throw new Error(`Run terminal update failed for ${input.runId}`)

      if (input.requestMemoryExtraction === true) {
        await tx.insert(outboxEvents).values(memoryExtractionOutbox(input.runId))
      }

      return {
        status: 'committed' as const,
        article,
        event: JobEventSchema.parse({
          event: 'done',
          data: { ...eventData, _seq: seq },
        }) as Extract<JobEvent, { event: 'done' }>,
      }
    })
  }

  async terminateClaim(input: TerminateClaimInput): Promise<TerminateClaimResult> {
    const errorCode =
      input.outcome === 'failed' ? boundedError(input.errorCode, 'errorCode') : null
    const errorMessage =
      input.outcome === 'failed'
        ? boundedError(input.errorMessage, 'errorMessage')
        : null
    const eventType = input.outcome === 'failed' ? 'error' : 'cancelled'
    const eventData = input.outcome === 'failed' ? { message: errorMessage! } : {}
    const terminalIdempotencyKey = `job:${input.jobId}:terminal:${eventType}:v1`

    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, input.jobId))
        .for('update')
        .limit(1)
      if (!job) return { status: 'lease_lost' as const }

      if (job.status === input.outcome) {
        const [run] = await tx
          .select({ leaseToken: runs.leaseToken })
          .from(runs)
          .where(
            and(
              eq(runs.id, input.runId),
              eq(runs.jobId, input.jobId),
              eq(runs.status, input.outcome),
            ),
          )
          .limit(1)
        const [eventRow] = await tx
          .select()
          .from(jobEvents)
          .where(
            and(
              eq(jobEvents.jobId, input.jobId),
              eq(jobEvents.idempotencyKey, terminalIdempotencyKey),
            ),
          )
          .limit(1)
        if (run?.leaseToken !== input.leaseToken || eventRow?.eventType !== eventType) {
          return { status: 'lease_lost' as const }
        }
        if (
          input.outcome === 'failed' &&
          (job.errorCode !== errorCode || job.errorMessage !== errorMessage)
        ) {
          throw new Error(`Terminal idempotency collision for ${input.jobId}`)
        }
        return {
          status: 'replayed' as const,
          event: JobEventSchema.parse({
            event: eventType,
            data: { ...eventRow.eventData, _seq: eventRow.seq },
          }) as Extract<JobEvent, { event: 'cancelled' | 'error' }>,
        }
      }

      if (
        job.status !== 'running' ||
        job.leaseToken !== input.leaseToken ||
        !job.leaseExpiresAt
      ) {
        return { status: 'lease_lost' as const }
      }
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
      if (job.cancelRequestedAt && input.outcome !== 'cancelled') {
        return { status: 'cancel_requested' as const }
      }

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
      if (!run) return { status: 'lease_lost' as const }

      const seq = job.nextEventSeq
      await tx.insert(jobEvents).values({
        jobId: input.jobId,
        seq,
        runId: input.runId,
        idempotencyKey: terminalIdempotencyKey,
        payloadFingerprint: eventFingerprint(eventType, eventData),
        eventType,
        eventData,
      })

      const [settledJob] = await tx
        .update(jobs)
        .set({
          status: input.outcome,
          nextEventSeq: seq + 1,
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
          ),
        )
        .returning({ finishedAt: jobs.finishedAt })
      if (!settledJob?.finishedAt) {
        throw new Error(`Job terminal update failed for ${input.jobId}`)
      }

      await tx
        .update(runEffects)
        .set({
          status: 'uncertain',
          errorCode: 'run_terminal_with_reserved_effect',
          errorMessage: 'The run terminated before the effect outcome was recorded.',
          finishedAt: settledJob.finishedAt,
          updatedAt: settledJob.finishedAt,
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
          finishedAt: settledJob.finishedAt,
          updatedAt: settledJob.finishedAt,
        })
        .where(
          and(
            eq(traceSpans.jobId, input.jobId),
            eq(traceSpans.runId, input.runId),
            eq(traceSpans.status, 'running'),
          ),
        )

      const [settledRun] = await tx
        .update(runs)
        .set({
          status: input.outcome,
          errorCode,
          errorMessage,
          finishedAt: settledJob.finishedAt,
          updatedAt: settledJob.finishedAt,
        })
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.jobId, input.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: runs.id })
      if (!settledRun) throw new Error(`Run terminal update failed for ${input.runId}`)

      return {
        status: 'settled' as const,
        event: JobEventSchema.parse({
          event: eventType,
          data: { ...eventData, _seq: seq },
        }) as Extract<JobEvent, { event: 'cancelled' | 'error' }>,
      }
    })
  }

  async pauseClaim(input: PauseClaimInput): Promise<PauseClaimResult> {
    const interruptId = requireText(input.interruptId, 'interruptId', 512)
    const outline = input.outline.map((item) => item.trim())
    if (outline.length < 1 || outline.length > 6 || outline.some((item) => !item)) {
      throw new Error('outline must contain 1-6 non-empty chapters')
    }
    // 一次 Job 可以多次要求用户确认大纲。interruptId 在同一轮 checkpoint replay
    // 中稳定、在下一轮修改后变化，因此既能重放当前暂停，又不会与上一轮冲突。
    const idempotencyKey = `job:${input.jobId}:awaiting:outline:${interruptId}:v2`
    const legacyIdempotencyKey = `job:${input.jobId}:awaiting:outline:v1`
    const eventData = { outline }

    // LangGraph Checkpoint 保存“从哪里继续”；本事务保存用户可见的业务事实：
    // 当前待确认的大纲、outline_ready 事件、awaiting_input 状态和租约释放。
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, input.jobId))
        .for('update')
        .limit(1)
      if (!job) return { status: 'lease_lost' as const }

      if (job.status === 'awaiting_input') {
        const [run] = await tx
          .select({ leaseToken: runs.leaseToken })
          .from(runs)
          .where(
            and(
              eq(runs.id, input.runId),
              eq(runs.jobId, input.jobId),
              eq(runs.status, 'completed'),
            ),
          )
          .limit(1)
        let [eventRow] = await tx
          .select()
          .from(jobEvents)
          .where(
            and(
              eq(jobEvents.jobId, input.jobId),
              eq(jobEvents.runId, input.runId),
              eq(jobEvents.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
        // 兼容部署前已经持久化的第一轮 outline_ready；新暂停一律写 v2 key。
        if (!eventRow) {
          const [legacyEventRow] = await tx
            .select()
            .from(jobEvents)
            .where(
              and(
                eq(jobEvents.jobId, input.jobId),
                eq(jobEvents.runId, input.runId),
                eq(jobEvents.idempotencyKey, legacyIdempotencyKey),
              ),
            )
            .limit(1)
          eventRow = legacyEventRow
        }
        const [interrupt] = await tx
          .select()
          .from(jobInterrupts)
          .where(
            and(
              eq(jobInterrupts.jobId, input.jobId),
              eq(jobInterrupts.externalId, interruptId),
            ),
          )
          .limit(1)
        if (
          run?.leaseToken !== input.leaseToken ||
          eventRow?.eventType !== 'outline_ready' ||
          !interrupt ||
          interrupt.runId !== input.runId ||
          interrupt.status !== 'pending'
        ) {
          return { status: 'lease_lost' as const }
        }
        if (
          JSON.stringify(eventRow.eventData) !== JSON.stringify(eventData) ||
          JSON.stringify(interrupt.payload) !== JSON.stringify(eventData)
        ) {
          throw new Error(`Awaiting-input idempotency collision for ${input.jobId}`)
        }
        return {
          status: 'replayed' as const,
          event: JobEventSchema.parse({
            event: 'outline_ready',
            data: { ...eventRow.eventData, _seq: eventRow.seq },
          }) as Extract<JobEvent, { event: 'outline_ready' }>,
        }
      }

      if (
        job.status !== 'running' ||
        job.leaseToken !== input.leaseToken ||
        !job.leaseExpiresAt
      ) {
        return { status: 'lease_lost' as const }
      }
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

      const seq = job.nextEventSeq
      await tx.insert(jobInterrupts).values({
        jobId: input.jobId,
        runId: input.runId,
        externalId: interruptId,
        payload: eventData,
      })
      await tx.insert(jobEvents).values({
        jobId: input.jobId,
        seq,
        runId: input.runId,
        idempotencyKey,
        payloadFingerprint: eventFingerprint('outline_ready', eventData),
        eventType: 'outline_ready',
        eventData,
      })
      const [pausedJob] = await tx
        .update(jobs)
        .set({
          status: 'awaiting_input',
          stage: 'plan',
          nextEventSeq: seq + 1,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: sql`clock_timestamp()`,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, 'running'),
            eq(jobs.leaseToken, input.leaseToken),
          ),
        )
        .returning({ updatedAt: jobs.updatedAt })
      if (!pausedJob) throw new Error(`Job pause failed for ${input.jobId}`)

      await tx
        .update(runEffects)
        .set({
          status: 'uncertain',
          errorCode: 'run_paused_with_reserved_effect',
          errorMessage: 'The run paused before the effect outcome was recorded.',
          finishedAt: pausedJob.updatedAt,
          updatedAt: pausedJob.updatedAt,
        })
        .where(
          and(
            eq(runEffects.jobId, input.jobId),
            eq(runEffects.runId, input.runId),
            eq(runEffects.status, 'reserved'),
          ),
        )

      const [pausedRun] = await tx
        .update(runs)
        .set({
          status: 'completed',
          finishedAt: pausedJob.updatedAt,
          updatedAt: pausedJob.updatedAt,
        })
        .where(
          and(
            eq(runs.id, input.runId),
            eq(runs.jobId, input.jobId),
            eq(runs.status, 'running'),
            eq(runs.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: runs.id })
      if (!pausedRun) throw new Error(`Run pause failed for ${input.runId}`)

      return {
        status: 'paused' as const,
        event: JobEventSchema.parse({
          event: 'outline_ready',
          data: { ...eventData, _seq: seq },
        }) as Extract<JobEvent, { event: 'outline_ready' }>,
      }
    })
  }
}

export function createTerminalRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new TerminalRepository(db)
}
