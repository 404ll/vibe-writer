import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createJobRepository, type RunExecutionSnapshot } from '../src/repositories/jobs'
import {
  createEvalSamplingRepository,
} from '../src/repositories/eval-sampling'
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
  modelProfile: { profile: 'scanner-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'scanner-test',
} satisfies RunExecutionSnapshot

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      eval_candidate_events, eval_candidates, eval_sampling_policies,
      article_versions, articles, job_commands, job_interrupts,
      checkpoint_attempts, run_effects, job_events, runs, outbox_events,
      jobs, workspace_memberships, principal_identities, workspaces, principals CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function provision(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId: randomUUID(),
    slug: `scanner-${randomUUID().slice(0, 8)}`,
    name: 'Eval scanner workspace',
    role,
  })
}

async function addMember(
  workspaceId: string,
  role: 'owner' | 'editor' | 'viewer',
) {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId,
    slug: `ignored-${randomUUID().slice(0, 8)}`,
    name: 'Existing scanner workspace',
    role,
  })
}

async function completeSource(scope: AuthorizedWorkspaceScope, suffix: string) {
  const jobs = createJobRepository(db)
  const { job } = await jobs.createJob({
    workspaceId: scope.workspaceId,
    createdByPrincipalId: scope.principalId,
    idempotencyKey: `scanner-source-${suffix}`,
    topic: `Private scanner topic ${suffix}`,
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: `scanner-source-worker-${suffix}`,
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claim) throw new Error('Expected scanner source claim')
  const terminal = await createTerminalRepository(db).completeClaim({
    jobId: job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    exportIdempotencyKey: `job:${job.id}:article:export`,
    topic: `Private scanner topic ${suffix}`,
    markdown: `# Private scanner article ${suffix}\n\nNever copy this body to candidates.`,
    outputPath: null,
  })
  if (!('article' in terminal)) throw new Error('Expected scanner source article')
  return { job, run: claim.run, article: terminal.article }
}

const policyInput = {
  samplerKey: 'completed-production-run',
  samplerVersion: 'v1',
  sampleRateBps: 10_000,
  consentPolicyVersion: 'workspace-eval-consent-v1',
  retentionDays: 30,
}

describe('automatic live Eval sampling policy and cursor', () => {
  it('requires an owner and preserves immutable policy versions', async () => {
    const owner = await provision()
    const editor = await addMember(owner.workspaceId, 'editor')
    const repository = createEvalSamplingRepository(db)
    await expect(repository.configurePolicy(editor, policyInput))
      .rejects.toBeInstanceOf(WorkspacePermissionError)

    const first = await repository.configurePolicy(owner, policyInput)
    const replay = await repository.configurePolicy(owner, policyInput)
    expect(first).toMatchObject({ created: true, policy: { status: 'active' } })
    expect(replay).toMatchObject({ created: false, policy: { id: first.policy.id } })
    await expect(repository.configurePolicy(owner, {
      ...policyInput,
      sampleRateBps: 5_000,
    })).rejects.toThrow('version collision')

    const second = await repository.configurePolicy(owner, {
      ...policyInput,
      samplerVersion: 'v2',
      sampleRateBps: 5_000,
    })
    expect(second).toMatchObject({ created: true, policy: { status: 'active' } })
    expect((await repository.listPolicies(owner)).map((policy) => policy.status))
      .toEqual(['disabled', 'active'])
  })

  it('advances a durable cursor in bounded batches without copying content', async () => {
    const owner = await provision()
    const repository = createEvalSamplingRepository(db)
    const configured = await repository.configurePolicy(owner, policyInput)
    const firstSource = await completeSource(owner, 'a')
    const secondSource = await completeSource(owner, 'b')

    await expect(repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 1 }))
      .resolves.toEqual({
        policiesScanned: 1,
        sourcesSeen: 1,
        candidatesCreated: 1,
        candidatesExisting: 0,
        cursorsAdvanced: 1,
      })
    const afterFirst = await repository.listPolicies(owner)
    expect(afterFirst[0]).toMatchObject({
      id: configured.policy.id,
      cursorRunId: firstSource.run.id,
    })
    await expect(repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 1 }))
      .resolves.toMatchObject({ sourcesSeen: 1, candidatesCreated: 1, cursorsAdvanced: 1 })
    await expect(repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 1 }))
      .resolves.toMatchObject({ sourcesSeen: 0, candidatesCreated: 0, cursorsAdvanced: 0 })

    const candidates = await db.select().from(schema.evalCandidates)
      .orderBy(schema.evalCandidates.createdAt, schema.evalCandidates.id)
    expect(candidates).toHaveLength(2)
    expect(candidates.map((candidate) => candidate.sourceRunId)).toEqual([
      firstSource.run.id,
      secondSource.run.id,
    ])
    expect(candidates.every(
      (candidate) => candidate.samplingPolicyId === configured.policy.id,
    )).toBe(true)
    const serialized = JSON.stringify(candidates)
    expect(serialized).not.toContain('Private scanner topic')
    expect(serialized).not.toContain('Never copy this body')
  })

  it('inherits the cursor when a new policy version replaces the active version', async () => {
    const owner = await provision()
    const repository = createEvalSamplingRepository(db)
    await repository.configurePolicy(owner, policyInput)
    const oldSource = await completeSource(owner, 'old')
    await repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 10 })
    const replacement = await repository.configurePolicy(owner, {
      ...policyInput,
      samplerVersion: 'v2',
      consentPolicyVersion: 'workspace-eval-consent-v2',
    })
    expect(replacement.policy.cursorRunId).toBe(oldSource.run.id)
    await expect(repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 10 }))
      .resolves.toMatchObject({ sourcesSeen: 0, candidatesCreated: 0 })
    const newSource = await completeSource(owner, 'new')
    await expect(repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 10 }))
      .resolves.toMatchObject({ sourcesSeen: 1, candidatesCreated: 1 })
    const candidates = await db.select().from(schema.evalCandidates)
      .orderBy(schema.evalCandidates.createdAt, schema.evalCandidates.id)
    expect(candidates.map((candidate) => ({
      runId: candidate.sourceRunId,
      version: candidate.samplerVersion,
    }))).toEqual([
      { runId: oldSource.run.id, version: 'v1' },
      { runId: newSource.run.id, version: 'v2' },
    ])
  })

  it('does not scan disabled policies', async () => {
    const owner = await provision()
    const repository = createEvalSamplingRepository(db)
    const configured = await repository.configurePolicy(owner, policyInput)
    await repository.disablePolicy(owner, configured.policy.id)
    await completeSource(owner, 'disabled')
    await expect(repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 10 }))
      .resolves.toEqual({
        policiesScanned: 0,
        sourcesSeen: 0,
        candidatesCreated: 0,
        candidatesExisting: 0,
        cursorsAdvanced: 0,
      })
    expect(await db.select().from(schema.evalCandidates)).toEqual([])
  })

  it('rotates bounded policy batches fairly even when a workspace has no new sources', async () => {
    const firstOwner = await provision()
    const secondOwner = await provision()
    const repository = createEvalSamplingRepository(db)
    const first = await repository.configurePolicy(firstOwner, policyInput)
    const second = await repository.configurePolicy(secondOwner, policyInput)

    await expect(repository.scanActivePolicies({ policyLimit: 1, sourceBatchSize: 10 }))
      .resolves.toMatchObject({ policiesScanned: 1, sourcesSeen: 0 })
    await expect(repository.scanActivePolicies({ policyLimit: 1, sourceBatchSize: 10 }))
      .resolves.toMatchObject({ policiesScanned: 1, sourcesSeen: 0 })

    const policies = await db.select().from(schema.evalSamplingPolicies)
    expect(policies).toHaveLength(2)
    expect(policies.every((policy) => policy.lastScannedAt !== null)).toBe(true)
    expect(new Set(policies.map((policy) => policy.id))).toEqual(
      new Set([first.policy.id, second.policy.id]),
    )
  })

  it('fails closed and leaves the cursor unchanged when a completed run lacks an article', async () => {
    const owner = await provision()
    const repository = createEvalSamplingRepository(db)
    const configured = await repository.configurePolicy(owner, policyInput)
    const jobs = createJobRepository(db)
    const { job } = await jobs.createJob({
      workspaceId: owner.workspaceId,
      createdByPrincipalId: owner.principalId,
      idempotencyKey: 'scanner-missing-article',
      topic: 'Missing article',
      intervention: { on_outline: false },
    })
    const claim = await jobs.claimJob({
      jobId: job.id,
      workerId: 'scanner-broken-source',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!claim) throw new Error('Expected broken source claim')
    await db.update(schema.jobs).set({
      status: 'completed',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: new Date(),
    }).where(eq(schema.jobs.id, job.id))
    await db.update(schema.runs).set({
      status: 'completed',
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: new Date(),
    }).where(eq(schema.runs.id, claim.run.id))

    await expect(repository.scanActivePolicies({ policyLimit: 10, sourceBatchSize: 10 }))
      .rejects.toThrow('missing its source article')
    expect((await repository.listPolicies(owner))[0]).toMatchObject({
      id: configured.policy.id,
      cursorFinishedAt: null,
      cursorRunId: null,
    })
    expect(await db.select().from(schema.evalCandidates)).toEqual([])
  })
})
