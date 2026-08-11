import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createEvalCandidateRepository } from '../src/repositories/eval-candidates'
import { createEvalMaterializationRepository } from '../src/repositories/eval-materialization'
import { createEvalRepository } from '../src/repositories/evals'
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
  modelProfile: { profile: 'materialization-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'materialization-test',
} satisfies RunExecutionSnapshot

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      eval_candidate_events, eval_cases, eval_suites, eval_candidates,
      eval_sampling_policies, article_versions, articles, job_commands,
      job_interrupts, checkpoint_attempts, run_effects, job_events, runs,
      outbox_events, jobs, workspace_memberships, principal_identities,
      workspaces, principals CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function provision() {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId: randomUUID(),
    slug: `materialize-${randomUUID().slice(0, 8)}`,
    name: 'Eval materialization workspace',
  })
}

async function addMember(workspaceId: string, role: 'editor' | 'viewer') {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId,
    slug: `ignored-${randomUUID().slice(0, 8)}`,
    name: 'Existing materialization workspace',
    role,
  })
}

async function approvedCandidate(scope: AuthorizedWorkspaceScope, suffix: string) {
  const jobs = createJobRepository(db)
  const { job } = await jobs.createJob({
    workspaceId: scope.workspaceId,
    createdByPrincipalId: scope.principalId,
    idempotencyKey: `materialization-source-${suffix}`,
    topic: `Private materialization topic ${suffix}`,
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: `materialization-source-worker-${suffix}`,
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claim) throw new Error('Expected materialization source claim')
  const terminal = await createTerminalRepository(db).completeClaim({
    jobId: job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    exportIdempotencyKey: `job:${job.id}:article:export`,
    topic: `Private materialization topic ${suffix}`,
    markdown: `# Private materialized article ${suffix}\n\nApproved Eval body ${suffix}.`,
    outputPath: null,
  })
  if (!('article' in terminal)) throw new Error('Expected materialization source article')
  const candidates = createEvalCandidateRepository(db)
  const sampled = await candidates.sampleCompletedRun({
    sourceRunId: claim.run.id,
    samplerKey: 'materialization-test',
    samplerVersion: 'v1',
    sampleRateBps: 10_000,
    consent: { basis: 'workspace_policy', policyVersion: 'eval-consent-v1' },
    retentionUntil: new Date(Date.now() + 86_400_000),
  })
  if (sampled.status !== 'selected') throw new Error('Expected materialization candidate')
  await candidates.reviewCandidate(scope, {
    candidateId: sampled.candidate.id,
    decision: 'approved',
    reasonCode: 'approved_for_regression_dataset',
  })
  return { job, run: claim.run, article: terminal.article, candidate: sampled.candidate }
}

const materializationInput = (candidateIds: string[]) => ({
  candidateIds,
  suiteKey: 'approved-live-articles',
  suiteVersion: 'v1',
  name: 'Approved live articles',
  description: 'Owner-reviewed production article regression inputs.',
  materializerKey: 'approved-article-copy',
  materializerVersion: 'v1',
})

describe('approved live Eval dataset materialization', () => {
  it('requires the owner and refuses generic non-synthetic suite creation', async () => {
    const owner = await provision()
    const editor = await addMember(owner.workspaceId, 'editor')
    const source = await approvedCandidate(owner, 'owner')
    await expect(
      createEvalMaterializationRepository(db).materializeApprovedCandidates(
        editor,
        materializationInput([source.candidate.id]),
      ),
    ).rejects.toBeInstanceOf(WorkspacePermissionError)
    await expect(createEvalRepository(db).createSuite({
      namespaceKey: 'unsafe-live-suite',
      suiteKey: 'unsafe-live-suite',
      version: 'v1',
      name: 'Unsafe live suite',
      dataClassification: 'user_content',
      cases: [{ key: 'unsafe', input: { markdown: 'bypass' } }],
    })).rejects.toThrow('must use governed materialization')
  })

  it('atomically materializes an approved batch as one immutable draft suite', async () => {
    const owner = await provision()
    const first = await approvedCandidate(owner, 'first')
    const second = await approvedCandidate(owner, 'second')
    const repository = createEvalMaterializationRepository(db)
    const input = materializationInput([second.candidate.id, first.candidate.id])

    const created = await repository.materializeApprovedCandidates(owner, input)
    const replay = await repository.materializeApprovedCandidates(owner, input)
    expect(created).toMatchObject({
      created: true,
      suite: {
        workspaceId: owner.workspaceId,
        namespaceKey: `workspace:${owner.workspaceId}`,
        suiteKey: input.suiteKey,
        version: input.suiteVersion,
        status: 'draft',
      },
    })
    expect(created.cases).toHaveLength(2)
    expect(replay).toMatchObject({ created: false, suite: { id: created.suite.id } })
    const serializedCases = JSON.stringify(created.cases)
    expect(serializedCases).toContain('Approved Eval body first')
    expect(serializedCases).toContain('Approved Eval body second')
    expect(serializedCases).not.toContain('Private materialization topic')
    expect(created.cases.every(
      (evalCase) =>
        evalCase.dataClassification === 'user_content' &&
        evalCase.retentionUntil !== null &&
        evalCase.materializerKey === input.materializerKey &&
        evalCase.materializerVersion === input.materializerVersion,
    )).toBe(true)
    const candidates = await db.select().from(schema.evalCandidates)
      .orderBy(schema.evalCandidates.id)
    expect(candidates.map((candidate) => candidate.status)).toEqual([
      'materialized',
      'materialized',
    ])
    const events = await db.select().from(schema.evalCandidateEvents)
      .orderBy(schema.evalCandidateEvents.candidateId, schema.evalCandidateEvents.seq)
    expect(events.filter((event) => event.eventType === 'materialized')).toHaveLength(2)
  })

  it('fails closed when the approved source article changed after review', async () => {
    const owner = await provision()
    const source = await approvedCandidate(owner, 'stale')
    await db.update(schema.articles).set({
      revision: source.article.revision + 1,
      content: '# Changed after approval',
      contentFingerprint: `sha256:${'1'.repeat(64)}`,
    }).where(eq(schema.articles.id, source.article.id))

    await expect(
      createEvalMaterializationRepository(db).materializeApprovedCandidates(
        owner,
        materializationInput([source.candidate.id]),
      ),
    ).rejects.toThrow('source article is stale or missing')
    expect(await db.select().from(schema.evalSuites)).toEqual([])
    expect(await db.select().from(schema.evalCases)).toEqual([])
    expect((await db.select().from(schema.evalCandidates))[0]?.status).toBe('approved')
  })

  it('purges retained content and archives its suite when a materialized candidate expires', async () => {
    const owner = await provision()
    const source = await approvedCandidate(owner, 'expiry')
    const materialized = await createEvalMaterializationRepository(db)
      .materializeApprovedCandidates(owner, materializationInput([source.candidate.id]))
    await db.update(schema.evalCandidates)
      .set({ retentionUntil: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(schema.evalCandidates.id, source.candidate.id))

    await expect(createEvalCandidateRepository(db).expireDue(10))
      .resolves.toMatchObject([{ id: source.candidate.id, status: 'expired' }])
    expect(await db.select().from(schema.evalCases)).toEqual([])
    expect((await db.select().from(schema.evalSuites))[0]).toMatchObject({
      id: materialized.suite.id,
      status: 'archived',
    })
    const events = await createEvalCandidateRepository(db)
      .listEventsForWorkspace(owner, source.candidate.id)
    expect(events.map((event) => event.eventType)).toEqual([
      'sampled',
      'approved',
      'materialized',
      'expired',
    ])
  })

  it('revalidates live dataset fingerprints before a run can start', async () => {
    const owner = await provision()
    const source = await approvedCandidate(owner, 'integrity')
    const materialized = await createEvalMaterializationRepository(db)
      .materializeApprovedCandidates(owner, materializationInput([source.candidate.id]))
    const materialization = createEvalMaterializationRepository(db)
    await expect(materialization.activateMaterializedSuite(owner, materialized.suite.id))
      .resolves.toMatchObject({ changed: true, suite: { status: 'active' } })
    await expect(materialization.activateMaterializedSuite(owner, materialized.suite.id))
      .resolves.toMatchObject({ changed: false, suite: { status: 'active' } })
    const runInput = {
      namespaceKey: materialized.suite.namespaceKey,
      suiteKey: materialized.suite.suiteKey,
      suiteVersion: materialized.suite.version,
      datasetFingerprint: materialized.suite.datasetFingerprint,
      trigger: 'manual' as const,
      targetKey: 'live-article-target',
      targetVersion: 'v1',
      execution: {
        modelProfile: 'scripted-v1',
        promptVersion: 'prompt-v1',
        graphVersion: 'graph-v1',
        toolVersions: { writer: 'writer-v1' },
        codeRevision: 'test',
      },
      trialsPerCase: 1,
    }
    await expect(createEvalRepository(db).startRun(runInput))
      .resolves.toMatchObject({ status: 'running' })
    await db.update(schema.evalCases)
      .set({ input: { corrupted: true } })
      .where(eq(schema.evalCases.suiteId, materialized.suite.id))
    await expect(createEvalRepository(db).startRun(runInput))
      .rejects.toThrow('immutable dataset fingerprint')
  })
})
