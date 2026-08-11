import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createJobRepository, type RunExecutionSnapshot } from '../src/repositories/jobs'
import {
  createMemoryRepository,
  MemoryCandidateNotFoundError,
  MemoryNotFoundError,
  MemoryReviewConflictError,
} from '../src/repositories/memories'
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
  modelProfile: { profile: 'memory-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'memory-source-v1',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'memory-test',
} satisfies RunExecutionSnapshot

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      memory_tombstones, memory_candidate_events, memory_revisions, memories,
      memory_candidates, article_versions, articles, job_commands, job_interrupts,
      checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs,
      workspace_memberships, principal_identities, workspaces, principals CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function provision(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId: randomUUID(),
    slug: `memory-${randomUUID().slice(0, 8)}`,
    name: 'Memory workspace',
    role,
  })
}

async function addMember(
  workspace: AuthorizedWorkspaceScope,
  role: 'owner' | 'editor' | 'viewer',
) {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId: workspace.workspaceId,
    slug: 'ignored-existing-memory-workspace',
    name: 'Ignored existing Memory workspace',
    role,
  })
}

async function completedSource(scope: AuthorizedWorkspaceScope) {
  const jobs = createJobRepository(db)
  const created = await jobs.createJob({
    workspaceId: scope.workspaceId,
    createdByPrincipalId: scope.principalId,
    idempotencyKey: `memory-source-${randomUUID()}`,
    topic: 'Memory source topic',
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: created.job.id,
    workerId: 'memory-source-worker',
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claim) throw new Error('Expected Memory source job claim')
  const terminal = await createTerminalRepository(db).completeClaim({
    jobId: created.job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    exportIdempotencyKey: `job:${created.job.id}:article:export`,
    topic: 'Memory source topic',
    markdown: '# Memory source article',
    outputPath: null,
  })
  if (!('article' in terminal)) throw new Error('Expected completed Memory source article')
  return { job: created.job, run: claim.run }
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function proposal(input: {
  workspaceId: string
  runId: string
  content?: string
  memoryKey?: string
  extractorVersion?: string
  proposedBy?: 'user' | 'model'
  confidence?: number
  sensitivity?: 'normal' | 'sensitive'
  expiresAt?: string
}) {
  return {
    schemaVersion: 2 as const,
    workspaceId: input.workspaceId,
    subject: { kind: 'workspace' as const, key: 'default' },
    memoryKey: input.memoryKey ?? 'writing.tone',
    kind: 'preference' as const,
    content: input.content ?? 'Prefer concise technical prose.',
    proposedBy: input.proposedBy ?? 'model',
    confidence: input.confidence ?? 0.95,
    sensitivity: input.sensitivity ?? 'normal',
    consent: { basis: 'workspace_policy' as const, policyVersion: 'memory-consent-v1' },
    source: {
      kind: 'run' as const,
      runId: input.runId,
      evidenceFingerprint: fingerprint(`evidence:${input.runId}`),
    },
    extractor: {
      key: 'writing-preference-extractor',
      version: input.extractorVersion ?? 'v1',
    },
    expiresAt: input.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
  }
}

describe('durable Memory governance', () => {
  it('persists eligible proposals idempotently and never stores rejected inferences', async () => {
    const owner = await provision()
    const source = await completedSource(owner)
    const repository = createMemoryRepository(db)
    const input = proposal({ workspaceId: owner.workspaceId, runId: source.run.id })

    const first = await repository.submitProposal(input)
    const replay = await repository.submitProposal(input)
    expect(first).toMatchObject({ status: 'candidate', created: true })
    expect(replay).toMatchObject({
      status: 'candidate',
      created: false,
      candidate: { id: first.status === 'candidate' ? first.candidate.id : '' },
    })
    expect(await db.select().from(schema.memoryCandidates)).toHaveLength(1)
    expect(await db.select().from(schema.memoryCandidateEvents)).toMatchObject([{
      seq: 0,
      eventType: 'proposed',
      reasonCode: 'policy_candidate_created',
    }])

    for (const rejected of [
      proposal({
        workspaceId: owner.workspaceId,
        runId: source.run.id,
        memoryKey: 'writing.low-confidence',
        extractorVersion: 'low-confidence-v1',
        confidence: 0.5,
      }),
      proposal({
        workspaceId: owner.workspaceId,
        runId: source.run.id,
        memoryKey: 'writing.sensitive',
        extractorVersion: 'sensitive-v1',
        sensitivity: 'sensitive',
      }),
      proposal({
        workspaceId: owner.workspaceId,
        runId: source.run.id,
        memoryKey: 'writing.expired',
        extractorVersion: 'expired-v1',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    ]) {
      await expect(repository.submitProposal(rejected)).resolves.toMatchObject({
        status: 'rejected',
      })
    }
    expect(await db.select().from(schema.memoryCandidates)).toHaveLength(1)
  })

  it('requires explicit review and explicit replacement for conflicts', async () => {
    const owner = await provision()
    const firstSource = await completedSource(owner)
    const repository = createMemoryRepository(db)
    const first = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: firstSource.run.id,
    }))
    if (first.status !== 'candidate') throw new Error('Expected Memory candidate')
    const materialized = await repository.reviewCandidate(owner, {
      candidateId: first.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_preference',
    })
    expect(materialized).toMatchObject({
      status: 'materialized',
      replayed: false,
      memory: { currentRevision: 1 },
    })
    if (materialized.status !== 'materialized') throw new Error('Expected materialized Memory')
    expect(await repository.listMemories(owner)).toMatchObject([{
      memory: { id: materialized.memory.id, currentRevision: 1 },
      revision: { content: 'Prefer concise technical prose.', revision: 1 },
    }])

    const duplicateSource = await completedSource(owner)
    await expect(repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: duplicateSource.run.id,
      extractorVersion: 'v2',
    }))).resolves.toMatchObject({
      status: 'duplicate',
      memory: { id: materialized.memory.id },
    })

    const conflictSource = await completedSource(owner)
    const conflict = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: conflictSource.run.id,
      content: 'Prefer detailed narrative explanations.',
      extractorVersion: 'v3',
    }))
    if (conflict.status !== 'conflict') throw new Error('Expected Memory conflict')
    await expect(repository.reviewCandidate(owner, {
      candidateId: conflict.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_change',
    })).rejects.toBeInstanceOf(MemoryReviewConflictError)
    const replaced = await repository.reviewCandidate(owner, {
      candidateId: conflict.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_change',
      replaceMemoryId: materialized.memory.id,
    })
    expect(replaced).toMatchObject({
      status: 'materialized',
      memory: { id: materialized.memory.id, currentRevision: 2 },
    })
    await expect(repository.reviewCandidate(owner, {
      candidateId: conflict.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_change',
      replaceMemoryId: materialized.memory.id,
    })).resolves.toMatchObject({ status: 'materialized', replayed: true })
    expect(await db.select().from(schema.memoryRevisions)).toHaveLength(2)
    expect((await repository.listCandidateEvents(owner, conflict.candidate.id))
      .map(({ eventType }) => eventType)).toEqual(['proposed', 'materialized'])
  })

  it('enforces reviewer permissions and workspace isolation', async () => {
    const owner = await provision()
    const viewer = await addMember(owner, 'viewer')
    const other = await provision()
    const source = await completedSource(owner)
    const repository = createMemoryRepository(db)
    const submitted = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: source.run.id,
    }))
    if (submitted.status !== 'candidate') throw new Error('Expected Memory candidate')

    await expect(repository.listCandidates(viewer)).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    )
    expect(await repository.listCandidates(other)).toEqual([])
    await expect(repository.reviewCandidate(other, {
      candidateId: submitted.candidate.id,
      decision: 'reject',
      reasonCode: 'other_workspace_review',
    })).rejects.toBeInstanceOf(MemoryCandidateNotFoundError)
    await expect(repository.reviewCandidate(owner, {
      candidateId: submitted.candidate.id,
      decision: 'reject',
      reasonCode: 'not_a_stable_preference',
    })).resolves.toMatchObject({ status: 'rejected', replayed: false })
    await expect(repository.reviewCandidate(owner, {
      candidateId: submitted.candidate.id,
      decision: 'reject',
      reasonCode: 'not_a_stable_preference',
    })).resolves.toMatchObject({ status: 'rejected', replayed: true })
  })

  it('paginates active Memory and candidate management reads by stable database cursor', async () => {
    const owner = await provision()
    const viewer = await addMember(owner, 'viewer')
    const repository = createMemoryRepository(db)
    for (const [memoryKey, extractorVersion] of [
      ['writing.audience', 'page-a'],
      ['writing.tone', 'page-b'],
    ] as const) {
      const source = await completedSource(owner)
      const submitted = await repository.submitProposal(proposal({
        workspaceId: owner.workspaceId,
        runId: source.run.id,
        memoryKey,
        extractorVersion,
      }))
      if (submitted.status !== 'candidate') throw new Error('Expected paged candidate')
      await repository.reviewCandidate(owner, {
        candidateId: submitted.candidate.id,
        decision: 'materialize',
        reasonCode: 'owner_confirmed_page_item',
      })
    }

    const first = await repository.listMemoriesPage(viewer, { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    const second = await repository.listMemoriesPage(viewer, {
      limit: 1,
      cursor: first.nextCursor!,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.memory.id).not.toBe(first.items[0]?.memory.id)
    expect(second.nextCursor).toBeNull()

    await expect(repository.listCandidatesPage(viewer, { limit: 1 }))
      .rejects.toBeInstanceOf(WorkspacePermissionError)
    const candidateFirst = await repository.listCandidatesPage(owner, { limit: 1 })
    expect(candidateFirst.items).toHaveLength(1)
    expect(candidateFirst.nextCursor).not.toBeNull()
    const candidateSecond = await repository.listCandidatesPage(owner, {
      limit: 1,
      cursor: candidateFirst.nextCursor!,
    })
    expect(candidateSecond.items).toHaveLength(1)
    expect(candidateSecond.items[0]?.id).not.toBe(candidateFirst.items[0]?.id)
    expect(candidateSecond.nextCursor).toBeNull()
  })

  it('hard-deletes the full slot and leaves only a content-free tombstone', async () => {
    const owner = await provision()
    const editor = await addMember(owner, 'editor')
    const source = await completedSource(owner)
    const repository = createMemoryRepository(db)
    const submitted = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: source.run.id,
    }))
    if (submitted.status !== 'candidate') throw new Error('Expected Memory candidate')
    const materialized = await repository.reviewCandidate(owner, {
      candidateId: submitted.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_preference',
    })
    if (materialized.status !== 'materialized') throw new Error('Expected materialized Memory')

    await expect(repository.deleteMemory(editor, {
      memoryId: materialized.memory.id,
      reasonCode: 'user_requested_erasure',
    })).rejects.toBeInstanceOf(WorkspacePermissionError)
    const deleted = await repository.deleteMemory(owner, {
      memoryId: materialized.memory.id,
      reasonCode: 'user_requested_erasure',
    })
    expect(deleted).toMatchObject({ status: 'deleted', replayed: false })
    await expect(repository.deleteMemory(owner, {
      memoryId: materialized.memory.id,
      reasonCode: 'user_requested_erasure',
    })).resolves.toMatchObject({ status: 'deleted', replayed: true })
    await expect(repository.deleteMemory(owner, {
      memoryId: materialized.memory.id,
      reasonCode: 'different_erasure_intent',
    })).rejects.toBeInstanceOf(MemoryNotFoundError)
    expect(await db.select().from(schema.memories)).toEqual([])
    expect(await db.select().from(schema.memoryRevisions)).toEqual([])
    expect(await db.select().from(schema.memoryCandidates)).toEqual([])
    expect(await db.select().from(schema.memoryCandidateEvents)).toEqual([])
    const tombstones = await db.select().from(schema.memoryTombstones)
    expect(tombstones).toHaveLength(1)
    expect(JSON.stringify(tombstones[0])).not.toContain('concise technical prose')
    expect(tombstones[0]).toMatchObject({
      memoryId: materialized.memory.id,
      reasonCode: 'user_requested_erasure',
      deletedByPrincipalId: owner.principalId,
    })
  })

  it('purges expired content and propagates source-run deletion', async () => {
    const owner = await provision()
    const repository = createMemoryRepository(db)
    const source = await completedSource(owner)
    const submitted = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: source.run.id,
    }))
    if (submitted.status !== 'candidate') throw new Error('Expected Memory candidate')
    const materialized = await repository.reviewCandidate(owner, {
      candidateId: submitted.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_preference',
    })
    if (materialized.status !== 'materialized') throw new Error('Expected materialized Memory')
    await db.delete(schema.jobs).where(eq(schema.jobs.id, source.job.id))
    expect(await db.select().from(schema.memories)).toEqual([])
    expect(await db.select().from(schema.memoryRevisions)).toEqual([])
    expect(await db.select().from(schema.memoryCandidates)).toEqual([])

    const expirySource = await completedSource(owner)
    const expiring = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: expirySource.run.id,
      extractorVersion: 'expiry-v1',
    }))
    if (expiring.status !== 'candidate') throw new Error('Expected expiring candidate')
    const expiringMemory = await repository.reviewCandidate(owner, {
      candidateId: expiring.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_preference',
    })
    if (expiringMemory.status !== 'materialized') throw new Error('Expected expiring Memory')
    const past = new Date('2000-01-01T00:00:00.000Z')
    await db.update(schema.memories).set({ expiresAt: past })
      .where(eq(schema.memories.id, expiringMemory.memory.id))
    await db.update(schema.memoryCandidates).set({ expiresAt: past })
      .where(eq(schema.memoryCandidates.id, expiring.candidate.id))
    await expect(repository.inspectExpiryBacklog()).resolves.toEqual({
      memoriesDue: 1,
      memoriesCapped: false,
      candidatesDue: 1,
      candidatesCapped: false,
    })
    await expect(repository.expireDue()).resolves.toEqual({
      memoriesDeleted: 1,
      candidatesDeleted: 1,
    })
    expect(await db.select().from(schema.memories)).toEqual([])
    expect(await db.select().from(schema.memoryRevisions)).toEqual([])
    expect(await db.select().from(schema.memoryCandidates)).toEqual([])
    expect(await db.select().from(schema.memoryTombstones)).toMatchObject([{
      memoryId: expiringMemory.memory.id,
      deletedByPrincipalId: null,
      reasonCode: 'retention_elapsed',
    }])
    await expect(repository.inspectExpiryBacklog()).resolves.toEqual({
      memoriesDue: 0,
      memoriesCapped: false,
      candidatesDue: 0,
      candidatesCapped: false,
    })
  })

  it('retires an expired active slot before accepting its replacement proposal', async () => {
    const owner = await provision()
    const repository = createMemoryRepository(db)
    const source = await completedSource(owner)
    const submitted = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: source.run.id,
    }))
    if (submitted.status !== 'candidate') throw new Error('Expected Memory candidate')
    const materialized = await repository.reviewCandidate(owner, {
      candidateId: submitted.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_preference',
    })
    if (materialized.status !== 'materialized') throw new Error('Expected materialized Memory')
    await db.update(schema.memories)
      .set({ expiresAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(schema.memories.id, materialized.memory.id))

    const replacementSource = await completedSource(owner)
    const replacement = await repository.submitProposal(proposal({
      workspaceId: owner.workspaceId,
      runId: replacementSource.run.id,
      content: 'Prefer current and concise technical prose.',
      extractorVersion: 'replacement-v1',
    }))
    expect(replacement).toMatchObject({ status: 'candidate', created: true })
    expect(await db.select().from(schema.memories)).toEqual([])
    expect(await db.select().from(schema.memoryRevisions)).toEqual([])
    expect(await db.select().from(schema.memoryTombstones)).toMatchObject([{
      memoryId: materialized.memory.id,
      reasonCode: 'retention_elapsed',
    }])
  })
})
