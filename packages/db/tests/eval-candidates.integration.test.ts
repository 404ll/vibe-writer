import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createEvalCandidateRepository,
  liveEvalSamplingBucket,
} from '../src/repositories/eval-candidates'
import { createJobRepository, type RunExecutionSnapshot } from '../src/repositories/jobs'
import { createTerminalRepository } from '../src/repositories/terminals'
import {
  WorkspacePermissionError,
  createWorkspaceRepository,
  type AuthorizedWorkspaceScope,
} from '../src/repositories/workspaces'
import * as schema from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
let client: PGlite
let db: PgliteDatabase<typeof schema>

const execution = {
  modelProfile: { profile: 'live-sampler-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'live-sampler-test',
} satisfies RunExecutionSnapshot

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      eval_candidate_events, eval_candidates, article_versions, articles,
      job_commands, job_interrupts, checkpoint_attempts, run_effects,
      job_events, runs, outbox_events, jobs, workspace_memberships,
      principal_identities, workspaces, principals CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function provision(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId: randomUUID(),
    slug: `eval-${randomUUID().slice(0, 8)}`,
    name: 'Eval candidate workspace',
    role,
  })
}

async function completedSource(scope: AuthorizedWorkspaceScope) {
  const jobs = createJobRepository(db)
  const created = await jobs.createJob({
    workspaceId: scope.workspaceId,
    createdByPrincipalId: scope.principalId,
    idempotencyKey: `live-sampler-${randomUUID()}`,
    topic: 'Private customer writing topic',
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: created.job.id,
    workerId: 'live-sampler-source-worker',
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claim) throw new Error('Expected source job claim')
  const terminal = await createTerminalRepository(db).completeClaim({
    jobId: created.job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    exportIdempotencyKey: `job:${created.job.id}:article:export`,
    topic: 'Private customer writing topic',
    markdown: '# Private customer article\n\nThis content must not enter the candidate ledger.',
    outputPath: null,
  })
  if (!('article' in terminal)) throw new Error('Expected completed source article')
  return { job: created.job, run: claim.run, article: terminal.article }
}

function samplingInput(sourceRunId: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceRunId,
    samplerKey: 'production-completed-run',
    samplerVersion: 'v1',
    sampleRateBps: 10_000,
    consent: {
      basis: 'workspace_policy' as const,
      policyVersion: 'eval-consent-v1',
    },
    retentionUntil: new Date(Date.now() + 86_400_000),
    ...overrides,
  }
}

describe('live Eval candidate governance', () => {
  it('requires consent and records only a content-free source pointer', async () => {
    const owner = await provision()
    const source = await completedSource(owner)
    const repository = createEvalCandidateRepository(db)

    await expect(repository.sampleCompletedRun({
      ...samplingInput(source.run.id),
      consent: null,
    })).resolves.toEqual({ status: 'not_selected', reason: 'consent_missing' })
    expect(await db.select().from(schema.evalCandidates)).toEqual([])

    const request = samplingInput(source.run.id)
    const first = await repository.sampleCompletedRun(request)
    const duplicate = await repository.sampleCompletedRun(request)
    if (first.status !== 'selected' || duplicate.status !== 'selected') {
      throw new Error('Expected selected candidate')
    }
    expect(first.created).toBe(true)
    expect(duplicate).toMatchObject({ created: false, candidate: { id: first.candidate.id } })
    expect(first.candidate).toMatchObject({
      workspaceId: owner.workspaceId,
      jobId: source.job.id,
      sourceRunId: source.run.id,
      sourceArticleId: source.article.id,
      sourceRevision: 0,
      contentFingerprint: source.article.contentFingerprint,
      dataClassification: 'user_content',
      status: 'pending_review',
      nextEventSeq: 1,
    })
    const serialized = JSON.stringify(first.candidate)
    expect(serialized).not.toContain('Private customer writing topic')
    expect(serialized).not.toContain('This content must not enter')
    expect(await repository.listEventsForWorkspace(owner, first.candidate.id))
      .toMatchObject([{
        seq: 0,
        eventType: 'sampled',
        actorPrincipalId: null,
        reasonCode: 'deterministic_sample_selected',
      }])
  })

  it('uses deterministic sampling and versions policy changes', async () => {
    const owner = await provision()
    const source = await completedSource(owner)
    const repository = createEvalCandidateRepository(db)
    let samplerVersion = 'excluded-v1'
    while (liveEvalSamplingBucket({
      workspaceId: owner.workspaceId,
      sourceRunId: source.run.id,
      samplerKey: 'production-completed-run',
      samplerVersion,
    }) === 0) {
      samplerVersion = `excluded-${randomUUID()}`
    }
    await expect(repository.sampleCompletedRun(samplingInput(source.run.id, {
      samplerVersion,
      sampleRateBps: 1,
    }))).resolves.toMatchObject({
      status: 'not_selected',
      reason: 'sample_rate',
      samplingBucket: expect.any(Number),
    })
    expect(await db.select().from(schema.evalCandidates)).toEqual([])
  })

  it('allows an editor review, rejects viewers, and isolates workspace reads', async () => {
    const owner = await provision()
    const source = await completedSource(owner)
    const repository = createEvalCandidateRepository(db)
    const selected = await repository.sampleCompletedRun(samplingInput(source.run.id))
    if (selected.status !== 'selected') throw new Error('Expected selected candidate')
    const viewer = await createWorkspaceRepository(db).provision({
      principalId: randomUUID(),
      workspaceId: owner.workspaceId,
      slug: 'ignored-existing-workspace',
      name: 'Ignored existing workspace',
      role: 'viewer',
    })
    await expect(repository.reviewCandidate(viewer, {
      candidateId: selected.candidate.id,
      decision: 'approved',
      reasonCode: 'quality_regression_review',
    })).rejects.toBeInstanceOf(WorkspacePermissionError)

    const reviewed = await repository.reviewCandidate(owner, {
      candidateId: selected.candidate.id,
      decision: 'approved',
      reasonCode: 'quality_regression_review',
    })
    expect(reviewed).toMatchObject({
      status: 'reviewed',
      replayed: false,
      candidate: {
        status: 'approved',
        reviewedByPrincipalId: owner.principalId,
        decisionReasonCode: 'quality_regression_review',
        nextEventSeq: 2,
      },
    })
    await expect(repository.reviewCandidate(owner, {
      candidateId: selected.candidate.id,
      decision: 'approved',
      reasonCode: 'quality_regression_review',
    })).resolves.toMatchObject({ status: 'reviewed', replayed: true })
    expect((await repository.listEventsForWorkspace(owner, selected.candidate.id))
      .map((event) => event.eventType)).toEqual(['sampled', 'approved'])

    const other = await provision()
    expect(await repository.listForWorkspace(other)).toEqual([])
    expect(await repository.listEventsForWorkspace(other, selected.candidate.id)).toEqual([])
  })

  it('expires due candidates with an append-only governance event', async () => {
    const owner = await provision()
    const source = await completedSource(owner)
    const repository = createEvalCandidateRepository(db)
    const selected = await repository.sampleCompletedRun(samplingInput(source.run.id))
    if (selected.status !== 'selected') throw new Error('Expected selected candidate')
    await db.update(schema.evalCandidates)
      .set({ retentionUntil: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(schema.evalCandidates.id, selected.candidate.id))

    await expect(repository.expireDue(10)).resolves.toMatchObject([{
      id: selected.candidate.id,
      status: 'expired',
      nextEventSeq: 2,
    }])
    expect((await repository.listEventsForWorkspace(owner, selected.candidate.id))
      .map((event) => ({ type: event.eventType, reason: event.reasonCode }))).toEqual([
      { type: 'sampled', reason: 'deterministic_sample_selected' },
      { type: 'expired', reason: 'retention_elapsed' },
    ])
    await expect(repository.expireDue(10)).resolves.toEqual([])
  })
})
