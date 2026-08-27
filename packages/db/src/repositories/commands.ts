import { createHash } from 'node:crypto'
import {
  ReplyRequestSchema,
  type ReplyRequest,
} from '@vibe-writer/contracts/jobs'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  jobCommands,
  jobInterrupts,
  jobs,
  outboxEvents,
  type JobCommandRow,
  type JobInterruptRow,
} from '../schema'
import type { VibeDatabase } from './jobs'

export type SubmitOutlineReplyInput = {
  jobId: string
  reply: ReplyRequest
}

export type SubmitOutlineReplyResult =
  | {
      status: 'queued' | 'replayed'
      interrupt: JobInterruptRow
      command: JobCommandRow
    }
  | { status: 'not_found' | 'not_awaiting_input' | 'already_terminal' }

function normalizeReply(value: ReplyRequest): ReplyRequest {
  const parsed = ReplyRequestSchema.parse(value)
  return {
    message: parsed.message,
    ...(parsed.outline !== undefined ? { outline: parsed.outline } : {}),
  }
}

function fingerprintReply(reply: ReplyRequest): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(reply)).digest('hex')}`
}

export class CommandRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async submitOutlineReply(
    input: SubmitOutlineReplyInput,
  ): Promise<SubmitOutlineReplyResult> {
    return this.submitOutlineReplyWithinWorkspace(input)
  }

  async submitOutlineReplyForWorkspace(
    input: SubmitOutlineReplyInput,
    workspaceId: string,
  ): Promise<SubmitOutlineReplyResult> {
    return this.submitOutlineReplyWithinWorkspace(input, workspaceId)
  }

  private async submitOutlineReplyWithinWorkspace(
    input: SubmitOutlineReplyInput,
    workspaceId?: string,
  ): Promise<SubmitOutlineReplyResult> {
    const reply = normalizeReply(input.reply)
    const payloadFingerprint = fingerprintReply(reply)

    // 回复、interrupt 状态、Job 重新排队和 resume Outbox 必须同事务提交。
    // API 返回成功后即使进程崩溃，调度器仍能根据 Outbox 再次投递恢复任务。
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(
          workspaceId
            ? and(eq(jobs.id, input.jobId), eq(jobs.workspaceId, workspaceId))
            : eq(jobs.id, input.jobId),
        )
        .for('update')
        .limit(1)
      if (!job) return { status: 'not_found' as const }

      const [pending] = await tx
        .select()
        .from(jobInterrupts)
        .where(
          and(
            eq(jobInterrupts.jobId, input.jobId),
            eq(jobInterrupts.status, 'pending'),
            eq(jobInterrupts.interruptType, 'outline_review'),
          ),
        )
        .orderBy(desc(jobInterrupts.createdAt))
        .limit(1)

      if (job.status !== 'awaiting_input' || !pending) {
        const [existing] = await tx
          .select({ command: jobCommands, interrupt: jobInterrupts })
          .from(jobCommands)
          .innerJoin(jobInterrupts, eq(jobInterrupts.id, jobCommands.interruptId))
          .where(eq(jobCommands.jobId, input.jobId))
          .orderBy(desc(jobCommands.createdAt))
          .limit(1)
        if (existing) {
          // 相同回复属于幂等重放；同一个 interrupt 下出现不同 payload 则是
          // 幂等键碰撞，必须拒绝，不能静默覆盖已经提交的人工决定。
          if (
            existing.command.payloadFingerprint !== payloadFingerprint ||
            JSON.stringify(existing.command.payload) !== JSON.stringify(reply)
          ) {
            throw new Error(`Reply idempotency collision for ${input.jobId}`)
          }
          return {
            status: 'replayed' as const,
            command: existing.command,
            interrupt: existing.interrupt,
          }
        }
        return ['completed', 'failed', 'cancelled'].includes(job.status)
          ? { status: 'already_terminal' as const }
          : { status: 'not_awaiting_input' as const }
      }

      const [command] = await tx
        .insert(jobCommands)
        .values({
          jobId: input.jobId,
          interruptId: pending.id,
          payload: reply,
          payloadFingerprint,
        })
        .returning()
      if (!command) throw new Error(`Reply command creation failed for ${input.jobId}`)

      const repliedAt = sql<Date>`clock_timestamp()`
      const [interrupt] = await tx
        .update(jobInterrupts)
        .set({
          status: 'replied',
          repliedAt,
          updatedAt: repliedAt,
        })
        .where(
          and(
            eq(jobInterrupts.id, pending.id),
            eq(jobInterrupts.status, 'pending'),
          ),
        )
        .returning()
      if (!interrupt) throw new Error(`Pending interrupt changed for ${input.jobId}`)

      const [queued] = await tx
        .update(jobs)
        .set({
          status: 'queued',
          updatedAt: repliedAt,
          version: sql`${jobs.version} + 1`,
        })
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.status, 'awaiting_input'),
          ),
        )
        .returning({ id: jobs.id })
      if (!queued) throw new Error(`Awaiting job changed for ${input.jobId}`)

      await tx.insert(outboxEvents).values({
        // resume 使用稳定身份；Outbox/BullMQ 可以重复投递，Worker 仍会通过
        // Job 状态、租约和 Checkpoint 判断是否真的拥有执行权。
        idempotencyKey: `job:${input.jobId}:resume:${interrupt.externalId}:v1`,
        aggregateType: 'job',
        aggregateId: input.jobId,
        eventType: 'job.resume.requested',
        payload: { jobId: input.jobId },
      })

      return { status: 'queued' as const, command, interrupt }
    })
  }

  async getOutlineReply(jobId: string, externalInterruptId: string) {
    const [row] = await this.db
      .select({ command: jobCommands, interrupt: jobInterrupts })
      .from(jobInterrupts)
      .innerJoin(jobCommands, eq(jobCommands.interruptId, jobInterrupts.id))
      .where(
        and(
          eq(jobInterrupts.jobId, jobId),
          eq(jobInterrupts.externalId, externalInterruptId),
          eq(jobInterrupts.status, 'replied'),
          eq(jobCommands.commandType, 'outline_reply'),
        ),
      )
      .limit(1)
    return row ? ReplyRequestSchema.parse(row.command.payload) : null
  }
}

export function createCommandRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new CommandRepository(db)
}
