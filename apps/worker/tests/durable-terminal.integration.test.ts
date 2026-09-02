import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { MemorySaver } from '@langchain/langgraph'
import { REVIEW_REPORT_VERSION } from '@vibe-writer/agent-core'
import {
  createCheckpointRepository,
  createCommandRepository,
  createJobRepository,
  createTerminalRepository,
  SYSTEM_PRINCIPAL_ID,
  SYSTEM_WORKSPACE_ID,
} from '@vibe-writer/db'
import * as schema from '@vibe-writer/db/schema'
import {
  WRITER_REVIEWER_WORKFLOW_VERSION,
  type WriterReviewerServices,
} from '@vibe-writer/workflow-runtime'
import type { TextModel, ToolModel } from '@vibe-writer/model-runtime'
import { count, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { describe, expect, it, vi } from 'vitest'
import {
  createFencedWorkflowCheckpointFactory,
  createWorkerLeaseControl,
  DurableWorkflowExecutor,
  EffectJournalModel,
  WorkerJobRunner,
} from '../src'

const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
)

const execution = {
  modelProfile: { profile: 'scripted', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: WRITER_REVIEWER_WORKFLOW_VERSION,
  toolVersions: { writerAgent: 'writer-agent-v1' },
  codeRevision: 'durable-terminal-test',
}

function services(): WriterReviewerServices {
  return {
    plan: vi.fn(async () => ['第一章']),
    reviseOutline: vi.fn(async ({ outline }) => outline),
    writeArticle: vi.fn(async ({ session }) => ({
      status: 'ready' as const,
      draft: '# Checkpoint crash recovery\n\n## 第一章\n第一章正文',
      session,
      sources: [],
      executions: [],
      modelCalls: [],
    })),
    reviewArticle: vi.fn(async () => ({
      status: 'ready' as const,
      report: {
        version: REVIEW_REPORT_VERSION as typeof REVIEW_REPORT_VERSION,
        verdict: 'approved' as const,
        summary: '通过',
        globalIssues: [],
        localIssues: [],
      },
        source: 'model' as const,
    })),
  }
}

describe('durable workflow terminal crash window', () => {
  it('persists a completed provider effect without prompt or response content', async () => {
    const client = await PGlite.create()
    try {
      const db = drizzle(client, { schema })
      await migrate(db, { migrationsFolder })
      const jobs = createJobRepository(db)
      const { job } = await jobs.createJob({
        workspaceId: SYSTEM_WORKSPACE_ID,
        createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
        idempotencyKey: 'durable-provider-effect',
        topic: 'Durable provider effect',
        intervention: { on_outline: false },
      })
      const claim = await jobs.claimJob({
        jobId: job.id,
        workerId: 'worker-effect',
        leaseDurationMs: 30_000,
        execution,
      })
      if (!claim) throw new Error('Expected provider-effect claim')

      const provider: TextModel & ToolModel = {
        generate: vi.fn(async () => ({
          text: 'private model response',
          provider: 'scripted',
          model: 'scripted-v1',
          finishReason: 'stop' as const,
          requestId: 'provider-request-1',
          usage: { inputTokens: 12, outputTokens: 3 },
        })),
        generateWithTools: vi.fn(),
      }
      const model = new EffectJournalModel(provider, jobs, {
        jobId: job.id,
        runId: claim.run.id,
        leaseToken: claim.leaseToken,
      })

      await model.generate({
        operation: 'planner.plan',
        promptVersion: 'prompt-v1',
        system: 'private system prompt',
        user: 'private user prompt',
        maxTokens: 100,
        metadata: { effectScope: 'plan:attempt:1' },
      })

      const [effect] = await db
        .select()
        .from(schema.runEffects)
        .where(eq(schema.runEffects.runId, claim.run.id))
      expect(effect).toMatchObject({
        jobId: job.id,
        runId: claim.run.id,
        effectKey: 'model:plan:attempt:1',
        effectType: 'model_call',
        status: 'succeeded',
        resultMetadata: {
          provider: 'scripted',
          model: 'scripted-v1',
          requestId: 'provider-request-1',
          usage: { inputTokens: 12, outputTokens: 3 },
        },
      })
      expect(effect?.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(JSON.stringify(effect)).not.toContain('private')

      await jobs.settleClaim({
        jobId: job.id,
        runId: claim.run.id,
        leaseToken: claim.leaseToken,
        outcome: 'failed',
        errorCode: 'test_terminal',
      })
      const [settledEffect] = await db
        .select()
        .from(schema.runEffects)
        .where(eq(schema.runEffects.runId, claim.run.id))
      expect(settledEffect?.status).toBe('succeeded')
    } finally {
      await client.close()
    }
  })

  it('replays a terminal checkpoint after takeover and commits one article', async () => {
    const client = await PGlite.create()
    try {
      const db = drizzle(client, { schema })
      await migrate(db, { migrationsFolder })
      const jobs = createJobRepository(db)
      const checkpoints = createCheckpointRepository(db)
      const terminals = createTerminalRepository(db)
      const { job } = await jobs.createJob({
        workspaceId: SYSTEM_WORKSPACE_ID,
        createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
        idempotencyKey: 'durable-terminal-crash-window',
        topic: 'Checkpoint crash recovery',
        intervention: { on_outline: false },
      })
      const first = await jobs.claimJob({
        jobId: job.id,
        workerId: 'worker-first',
        leaseDurationMs: 30_000,
        execution,
      })
      if (!first) throw new Error('Expected first claim')

      const workflowServices = services()
      const saver = new MemorySaver()
      const executor = new DurableWorkflowExecutor(
        workflowServices,
        createFencedWorkflowCheckpointFactory(saver, checkpoints),
        undefined,
        jobs,
      )
      const firstResult = await executor.execute({
        jobId: job.id,
        runId: first.run.id,
        leaseToken: first.leaseToken,
        job: first.job,
        run: first.run,
        signal: new AbortController().signal,
      })
      expect(firstResult.status).toBe('completed')
      expect((await checkpoints.getCheckpointAttempt(first.run.id))?.latestCheckpointId)
        .toEqual(expect.any(String))

      await db
        .update(schema.jobs)
        .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
        .where(eq(schema.jobs.id, job.id))
      const runner = new WorkerJobRunner(
        createWorkerLeaseControl(jobs, terminals),
        executor,
        {
          workerId: 'worker-takeover',
          leaseDurationMs: 30_000,
          heartbeatIntervalMs: 10_000,
          execution,
        },
      )

      await expect(runner.run(job.id)).resolves.toMatchObject({ status: 'completed' })
      expect(workflowServices.plan).toHaveBeenCalledTimes(1)
      expect(workflowServices.writeArticle).toHaveBeenCalledTimes(1)
      const [articleCount] = await db
        .select({ value: count() })
        .from(schema.articles)
        .where(eq(schema.articles.jobId, job.id))
      const [eventCount] = await db
        .select({ value: count() })
        .from(schema.jobEvents)
        .where(eq(schema.jobEvents.jobId, job.id))
      expect(articleCount?.value).toBe(1)
      expect(eventCount?.value).toBe(9)
      expect((await jobs.listEventsAfter(job.id)).map((event) => event.event)).toEqual([
        'stage_update',
        'stage_update',
        'writing_chapter',
        'writing_chapter',
        'stage_update',
        'reviewing_full',
        'review_done',
        'stage_update',
        'done',
      ])
      expect(await jobs.getJob(job.id)).toMatchObject({ status: 'completed' })
      const runRows = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.jobId, job.id))
        .orderBy(schema.runs.attempt)
      expect(runRows.map((run) => run.status)).toEqual(['failed', 'completed'])
    } finally {
      await client.close()
    }
  })

  it('persists an outline reply, reclaims the job and resumes the interrupt once', async () => {
    const client = await PGlite.create()
    try {
      const db = drizzle(client, { schema })
      await migrate(db, { migrationsFolder })
      const jobs = createJobRepository(db)
      const checkpoints = createCheckpointRepository(db)
      const terminals = createTerminalRepository(db)
      const commands = createCommandRepository(db)
      const { job } = await jobs.createJob({
        workspaceId: SYSTEM_WORKSPACE_ID,
        createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
        idempotencyKey: 'durable-outline-reply',
        topic: 'Durable outline reply',
        intervention: { on_outline: true },
      })
      const workflowServices = services()
      const executor = new DurableWorkflowExecutor(
        workflowServices,
        createFencedWorkflowCheckpointFactory(new MemorySaver(), checkpoints),
        commands,
        jobs,
      )
      const control = createWorkerLeaseControl(jobs, terminals)
      const firstRunner = new WorkerJobRunner(control, executor, {
        workerId: 'worker-outline-first',
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        execution,
      })

      await expect(firstRunner.run(job.id)).resolves.toMatchObject({
        status: 'awaiting_input',
      })
      expect(await jobs.getJob(job.id)).toMatchObject({ status: 'awaiting_input' })
      const [interrupt] = await db
        .select()
        .from(schema.jobInterrupts)
        .where(eq(schema.jobInterrupts.jobId, job.id))
      expect(interrupt).toMatchObject({ status: 'pending', payload: { outline: ['第一章'] } })

      await expect(
        commands.submitOutlineReply({
          jobId: job.id,
          reply: { message: '确认', outline: ['第一章'] },
        }),
      ).resolves.toMatchObject({ status: 'queued' })
      const secondRunner = new WorkerJobRunner(control, executor, {
        workerId: 'worker-outline-resume',
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        execution,
      })
      await expect(secondRunner.run(job.id)).resolves.toMatchObject({
        status: 'completed',
      })

      expect(workflowServices.plan).toHaveBeenCalledTimes(1)
      expect(workflowServices.writeArticle).toHaveBeenCalledTimes(1)
      expect(await jobs.getJob(job.id)).toMatchObject({ status: 'completed' })
      const [articleCount] = await db
        .select({ value: count() })
        .from(schema.articles)
        .where(eq(schema.articles.jobId, job.id))
      expect(articleCount?.value).toBe(1)
      expect((await jobs.listEventsAfter(job.id)).map((event) => event.event)).toEqual([
        'stage_update',
        'outline_ready',
        'stage_update',
        'writing_chapter',
        'writing_chapter',
        'stage_update',
        'reviewing_full',
        'review_done',
        'stage_update',
        'done',
      ])
    } finally {
      await client.close()
    }
  })
})
