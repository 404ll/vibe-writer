import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isInterrupted } from '@langchain/langgraph'
import { emptyCheckpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint'
import {
  createCheckpointRepository,
  createJobRepository,
  createPostgresDatabase,
  jobs,
  SYSTEM_PRINCIPAL_ID,
  SYSTEM_WORKSPACE_ID,
  type LeaseIdentity,
  type RunExecutionSnapshot,
} from '@vibe-writer/db'
import type {
  CoveragePlanResult,
  ReviewResult,
  ToolBudgetUsage,
  WriterResult,
} from '@vibe-writer/agent-core'
import {
  buildWorkflowGraph,
  createWorkflowState,
  resumeOutline,
  type WorkflowServices,
} from '@vibe-writer/workflow-runtime'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FencedCheckpointSaver,
  createPostgresSaver,
  initializeCheckpointAttempt,
} from '../src/runtime'

const connectionString = process.env.TEST_DATABASE_URL
const destructiveTestId = process.env.VIBE_WRITER_POSTGRES_TEST_ID
if (!connectionString || !destructiveTestId || !/^[0-9a-f]{32}$/.test(destructiveTestId)) {
  throw new Error('Harness-created PostgreSQL target is required')
}
const expectedDatabaseName = `vibe_writer_integration_${destructiveTestId}`
const expectedDatabaseComment = `vibe-writer-ephemeral:${destructiveTestId}`
const migrationsFolder = fileURLToPath(new URL('../../db/drizzle', import.meta.url))

const database = createPostgresDatabase(connectionString, { max: 2 })
let rawSaver = createPostgresSaver(connectionString)
const checkpointRepository = createCheckpointRepository(database.db)
const jobRepository = createJobRepository(database.db)

const execution = {
  modelProfile: { profile: 'postgres-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'postgres-checkpoint-test',
} satisfies RunExecutionSnapshot

function budget(): ToolBudgetUsage {
  return { totalCalls: 0, callsByTool: {} }
}

function readyWriter(content: string, usage = budget()): WriterResult {
  return {
    status: 'ready',
    content,
    executions: [],
    modelCalls: [],
    budgetUsage: usage,
    modelRequests: 1,
    toolRounds: 0,
  }
}

function readyCoverage(title: string): CoveragePlanResult {
  return {
    status: 'ready',
    points: [{ text: `覆盖 ${title}`, searchQuery: `${title} 查询` }],
  }
}

function review(verdict: ReviewResult['verdict']): ReviewResult {
  return { verdict, feedback: '', source: 'model' }
}

function services(): WorkflowServices {
  return {
    plan: vi.fn(async () => ['第一章']),
    reviseOutline: vi.fn(async ({ outline }) => outline),
    planCoverage: vi.fn(async ({ chapterTitle }) => readyCoverage(chapterTitle)),
    writeChapter: vi.fn(async ({ chapterTitle, budgetUsage }) =>
      readyWriter(`${chapterTitle}正文`, budgetUsage),
    ),
    reviewChapter: vi.fn(async () => review('passed')),
    reviewFull: vi.fn(async ({ chapters }) => chapters.map(() => review('passed'))),
  }
}

async function claim(idempotencyKey: string) {
  const { job } = await jobRepository.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey,
    topic: 'Postgres checkpoint integration',
    intervention: { on_outline: true },
  })
  const claimed = await jobRepository.claimJob({
    jobId: job.id,
    workerId: 'worker-a',
    leaseDurationMs: 60_000,
    execution,
  })
  if (!claimed) throw new Error('Expected job claim')
  const identity: LeaseIdentity = {
    jobId: job.id,
    runId: claimed.run.id,
    leaseToken: claimed.leaseToken,
  }
  return { job, claimed, identity }
}

async function takeover(jobId: string) {
  await database.db
    .update(jobs)
    .set({ leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') })
    .where(eq(jobs.id, jobId))
  const claimed = await jobRepository.claimJob({
    jobId,
    workerId: 'worker-b',
    leaseDurationMs: 60_000,
    execution,
  })
  if (!claimed) throw new Error('Expected takeover claim')
  return {
    claimed,
    identity: {
      jobId,
      runId: claimed.run.id,
      leaseToken: claimed.leaseToken,
    },
  }
}

beforeAll(async () => {
  const [target] = await database.client<
    { database: string; address: string | null; comment: string | null }[]
  >`
    SELECT current_database() AS database,
      host(inet_server_addr()) AS address,
      shobj_description(oid, 'pg_database') AS comment
    FROM pg_database WHERE datname = current_database()
  `
  if (
    target?.database !== expectedDatabaseName ||
    target.address !== '127.0.0.1' ||
    target.comment !== expectedDatabaseComment
  ) {
    throw new Error(`Refusing checkpoint integration target ${JSON.stringify(target)}`)
  }
  await migrate(database.db, { migrationsFolder })
  await rawSaver.setup()
})

beforeEach(async () => {
  await database.client.unsafe(
    'TRUNCATE TABLE checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs CASCADE;',
  )
})

afterAll(async () => {
  await Promise.all([rawSaver.end(), database.close()])
})

describe.sequential('real PostgresSaver attempt isolation', () => {
  it('sets up the dedicated schema and supports put/get/list', async () => {
    const tables = await database.client<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'langgraph_checkpoint'
      ORDER BY tablename
    `
    expect(tables.map((row) => row.tablename)).toEqual([
      'checkpoint_blobs',
      'checkpoint_migrations',
      'checkpoint_writes',
      'checkpoints',
    ])

    const value = {
      ...emptyCheckpoint(),
      id: '00000000-0000-6000-8000-000000000100',
      channel_values: { phase: 'plan' },
      channel_versions: { phase: 1 },
    }
    const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} }
    const config = await rawSaver.put(
      { configurable: { thread_id: `direct-${randomUUID()}`, checkpoint_ns: '' } },
      value,
      metadata,
      value.channel_versions,
    )
    await expect(rawSaver.getTuple(config)).resolves.toMatchObject({
      checkpoint: { channel_values: { phase: 'plan' } },
    })
    const listed = []
    for await (const item of rawSaver.list(config)) listed.push(item)
    expect(listed).toHaveLength(1)
  })

  it('forks pending writes and prevents a stale attempt from moving the pointer', async () => {
    const first = await claim('postgres-checkpoint-takeover')
    const firstSaver = await initializeCheckpointAttempt(
      rawSaver,
      checkpointRepository,
      first.identity,
    )
    const root = {
      ...emptyCheckpoint(),
      id: '00000000-0000-6000-8000-000000000110',
      channel_values: { chapter: 1 },
      channel_versions: { chapter: 1 },
    }
    const stored = await firstSaver.put(
      firstSaver.config(),
      root,
      { source: 'loop', step: 1, parents: {} },
      root.channel_versions,
    )
    await firstSaver.putWrites(stored, [['chapter_result', 'draft']], 'task-write')

    const second = await takeover(first.job.id)
    const secondSaver = await initializeCheckpointAttempt(
      rawSaver,
      checkpointRepository,
      second.identity,
    )
    expect(secondSaver.attempt.checkpointThreadId).not.toBe(
      firstSaver.attempt.checkpointThreadId,
    )
    expect(await rawSaver.getTuple(secondSaver.config(root.id))).toMatchObject({
      checkpoint: { channel_values: { chapter: 1 } },
      metadata: { source: 'fork' },
      pendingWrites: [['task-write', 'chapter_result', 'draft']],
    })

    await expect(
      firstSaver.putWrites(stored, [['chapter_result', 'zombie-draft']], 'zombie-task'),
    ).rejects.toMatchObject({ code: 'checkpoint_lease_lost' })
    await expect(
      firstSaver.put(
        firstSaver.config(root.id),
        { ...root, id: '00000000-0000-6000-8000-000000000111' },
        { source: 'loop', step: 2, parents: {} },
        root.channel_versions,
      ),
    ).rejects.toMatchObject({ code: 'checkpoint_lease_lost' })
    expect((await checkpointRepository.getCheckpointAttempt(second.identity.runId))).toMatchObject({
      latestCheckpointId: root.id,
      status: 'active',
    })
  })

  it('resumes an outline interrupt with a new saver and graph instance', async () => {
    const current = await claim('postgres-checkpoint-outline')
    const firstFenced = await initializeCheckpointAttempt(
      rawSaver,
      checkpointRepository,
      current.identity,
    )
    const workflowServices = services()
    let graph = buildWorkflowGraph(workflowServices, { checkpointer: firstFenced })
    const first = await graph.invoke(
      createWorkflowState({ jobId: current.job.id, topic: '持久化大纲' }),
      firstFenced.config(),
    )
    expect(isInterrupted(first)).toBe(true)

    await rawSaver.end()
    rawSaver = createPostgresSaver(connectionString)
    const active = await checkpointRepository.getCheckpointAttempt(current.identity.runId)
    if (!active) throw new Error('Expected active checkpoint attempt')
    const secondFenced = new FencedCheckpointSaver(
      rawSaver,
      checkpointRepository,
      current.identity,
      active,
    )
    graph = buildWorkflowGraph(workflowServices, { checkpointer: secondFenced })
    const completed = await graph.invoke(
      resumeOutline({ action: 'confirm' }),
      secondFenced.config(),
    )
    expect(completed).toMatchObject({ phase: 'completed', outline: ['第一章'] })
    expect(workflowServices.plan).toHaveBeenCalledTimes(1)
  })

  it('replays terminal and chapter checkpoints after rebuilding the saver', async () => {
    const current = await claim('postgres-checkpoint-replay')
    const initialFenced = await initializeCheckpointAttempt(
      rawSaver,
      checkpointRepository,
      current.identity,
    )
    const coverageCalls: string[] = []
    const writeCalls: string[] = []
    const reviewCalls: string[] = []
    const workflowServices: WorkflowServices = {
      ...services(),
      plan: vi.fn(async () => ['甲', '乙']),
      planCoverage: vi.fn(async ({ chapterTitle }) => {
        coverageCalls.push(chapterTitle)
        return readyCoverage(chapterTitle)
      }),
      writeChapter: vi.fn(async ({ chapterTitle, budgetUsage }) => {
        writeCalls.push(chapterTitle)
        return readyWriter(`${chapterTitle}正文`, budgetUsage)
      }),
      reviewChapter: vi.fn(async ({ chapterTitle }) => {
        reviewCalls.push(chapterTitle)
        return review('passed')
      }),
    }
    let graph = buildWorkflowGraph(workflowServices, { checkpointer: initialFenced })
    const result = await graph.invoke(
      createWorkflowState({
        jobId: current.job.id,
        topic: 'PostgreSQL 回放',
        interventionOnOutline: false,
      }),
      initialFenced.config(),
    )
    expect(result.phase).toBe('completed')

    const history: Array<Awaited<ReturnType<typeof graph.getState>>> = []
    for await (const snapshot of graph.getStateHistory(initialFenced.config())) {
      history.push(snapshot)
    }
    const terminal = history.find((snapshot) => snapshot.next.length === 0)
    const secondChapter = history.find(
      (snapshot) =>
        snapshot.values.currentChapterIndex === 1 && snapshot.next.includes('coverage'),
    )
    expect(terminal).toBeDefined()
    expect(secondChapter).toBeDefined()
    const beforeTerminalReplay = {
      coverage: coverageCalls.length,
      write: writeCalls.length,
      review: reviewCalls.length,
    }

    await rawSaver.end()
    rawSaver = createPostgresSaver(connectionString)
    const active = await checkpointRepository.getCheckpointAttempt(current.identity.runId)
    if (!active) throw new Error('Expected active checkpoint attempt')
    const rebuiltFenced = new FencedCheckpointSaver(
      rawSaver,
      checkpointRepository,
      current.identity,
      active,
    )
    graph = buildWorkflowGraph(workflowServices, { checkpointer: rebuiltFenced })
    const terminalReplay = await graph.replay(terminal!.config)
    expect(terminalReplay.phase).toBe('completed')
    expect({
      coverage: coverageCalls.length,
      write: writeCalls.length,
      review: reviewCalls.length,
    }).toEqual(beforeTerminalReplay)

    const chapterReplay = await graph.replay(secondChapter!.config)
    expect(chapterReplay.phase).toBe('completed')
    expect(coverageCalls.filter((title) => title === '甲')).toHaveLength(1)
    expect(writeCalls.filter((title) => title === '甲')).toHaveLength(1)
    expect(reviewCalls.filter((title) => title === '甲')).toHaveLength(1)
    expect(coverageCalls.filter((title) => title === '乙')).toHaveLength(2)
    expect(writeCalls.filter((title) => title === '乙')).toHaveLength(2)
    expect(reviewCalls.filter((title) => title === '乙')).toHaveLength(2)
  })
})
