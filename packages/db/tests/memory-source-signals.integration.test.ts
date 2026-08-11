import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createJobRepository,
  fingerprintEffectRequest,
  type RunExecutionSnapshot,
} from '../src/repositories/jobs'
import { createMemoryExtractionRepository } from '../src/repositories/memory-extractions'
import { createMemoryRepository } from '../src/repositories/memories'
import {
  createMemorySourceSignalRepository,
  MemorySourceSignalConflictError,
  MemorySourceSignalNotFoundError,
} from '../src/repositories/memory-source-signals'
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
  modelProfile: { profile: 'signal-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'signal-source-v1',
  toolVersions: { writer: 'writer-tools-v1' },
  codeRevision: 'signal-test',
} satisfies RunExecutionSnapshot

const memoryExecution = {
  extractorKey: 'signal-memory-extractor',
  extractorVersion: 'v1',
  promptVersion: 'signal-memory-prompt-v1',
  consentPolicyVersion: 'memory-consent-v1',
  retentionDays: 30,
  modelProfile: {
    profile: 'signal-memory',
    provider: 'scripted',
    model: 'scripted-memory-v1',
  },
}

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      memory_extraction_effects, memory_extraction_attempts, memory_extraction_tasks,
      memory_source_signal_tombstones, memory_source_signals,
      run_effects, job_events, runs, outbox_events, jobs,
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
    slug: `signal-${randomUUID().slice(0, 8)}`,
    name: 'Memory signal workspace',
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
    slug: 'ignored-existing-signal-workspace',
    name: 'Ignored existing Memory signal workspace',
    role,
  })
}

function signalInput(principalId: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `remember-${randomUUID()}`,
    sourceKind: 'explicit_remember' as const,
    subject: { kind: 'principal' as const, key: principalId },
    text: '以后默认使用简洁直接的技术表达。',
    consentPolicyVersion: 'memory-consent-v1',
    retentionDays: 30,
    ...overrides,
  }
}

describe('durable user-authored Memory source signals', () => {
  it('creates explicit-consent signals idempotently and rejects collisions', async () => {
    const owner = await provision()
    const repository = createMemorySourceSignalRepository(db)
    const input = signalInput(owner.principalId, { idempotencyKey: 'stable-request-1' })
    const first = await repository.create(owner, input)
    const replay = await repository.create(owner, input)
    expect(first).toMatchObject({
      created: true,
      signal: {
        createdByPrincipalId: owner.principalId,
        sourceKind: 'explicit_remember',
        subjectKind: 'principal',
        subjectKey: owner.principalId,
        consentBasis: 'explicit_user',
        consentPolicyVersion: 'memory-consent-v1',
      },
    })
    expect(replay).toMatchObject({ created: false, signal: { id: first.signal.id } })
    expect(first.signal.requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.signal.evidenceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    await expect(repository.create(owner, {
      ...input,
      text: 'A different request under the same key.',
    })).rejects.toBeInstanceOf(MemorySourceSignalConflictError)
    expect(await repository.listOwn(owner)).toHaveLength(1)
  })

  it('lets every member author only their own principal signal and reserves shared subjects for editors', async () => {
    const owner = await provision()
    const viewer = await addMember(owner, 'viewer')
    const editor = await addMember(owner, 'editor')
    const repository = createMemorySourceSignalRepository(db)
    await expect(repository.create(viewer, signalInput(viewer.principalId)))
      .resolves.toMatchObject({ created: true })
    await expect(repository.create(viewer, signalInput(owner.principalId)))
      .rejects.toBeInstanceOf(WorkspacePermissionError)
    await expect(repository.create(viewer, signalInput(viewer.principalId, {
      subject: { kind: 'workspace', key: 'default' },
    }))).rejects.toBeInstanceOf(WorkspacePermissionError)
    await expect(repository.create(editor, signalInput(editor.principalId, {
      subject: { kind: 'project', key: 'vibe-writer' },
      sourceKind: 'correction',
    }))).resolves.toMatchObject({ created: true })
    expect(await repository.listOwn(viewer)).toHaveLength(1)
    expect(await repository.listOwn(editor)).toHaveLength(1)
    expect(await repository.listOwn(owner)).toEqual([])
  })

  it('pages active own signals without overlap or another member data', async () => {
    const owner = await provision()
    const viewer = await addMember(owner, 'viewer')
    const repository = createMemorySourceSignalRepository(db)
    for (const suffix of ['first', 'second', 'third']) {
      await repository.create(owner, signalInput(owner.principalId, {
        idempotencyKey: `owner-${suffix}`,
        text: `Owner signal ${suffix}`,
      }))
    }
    await repository.create(viewer, signalInput(viewer.principalId, {
      idempotencyKey: 'viewer-only',
      text: 'Viewer private signal',
    }))

    const first = await repository.listOwnPage(owner, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await repository.listOwnPage(owner, {
      limit: 2,
      cursor: first.nextCursor!,
    })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items].map((signal) => signal.id)
    expect(new Set(ids).size).toBe(3)
    expect([...first.items, ...second.items].every(
      (signal) => signal.createdByPrincipalId === owner.principalId,
    )).toBe(true)
  })

  it('accepts only a source run owned by the signal author in the same workspace', async () => {
    const owner = await provision()
    const other = await provision()
    const jobs = createJobRepository(db)
    const ownJob = await jobs.createJob({
      workspaceId: owner.workspaceId,
      createdByPrincipalId: owner.principalId,
      idempotencyKey: 'own-run',
      topic: 'Own workspace task',
      intervention: { on_outline: false },
    })
    const ownClaim = await jobs.claimJob({
      jobId: ownJob.job.id,
      workerId: 'own-signal-source-worker',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!ownClaim) throw new Error('Expected own source run claim')
    await expect(createMemorySourceSignalRepository(db).create(owner, signalInput(
      owner.principalId,
      { sourceRunId: ownClaim.run.id },
    ))).resolves.toMatchObject({ created: true, signal: { sourceRunId: ownClaim.run.id } })
    const created = await jobs.createJob({
      workspaceId: other.workspaceId,
      createdByPrincipalId: other.principalId,
      idempotencyKey: 'other-run',
      topic: 'Other workspace task',
      intervention: { on_outline: false },
    })
    const claim = await jobs.claimJob({
      jobId: created.job.id,
      workerId: 'signal-source-worker',
      leaseDurationMs: 30_000,
      execution,
    })
    if (!claim) throw new Error('Expected source run claim')
    await expect(createMemorySourceSignalRepository(db).create(owner, signalInput(
      owner.principalId,
      { sourceRunId: claim.run.id },
    ))).rejects.toBeInstanceOf(MemorySourceSignalNotFoundError)
  })

  it('hard-deletes by author or owner and keeps only a content-free tombstone', async () => {
    const owner = await provision()
    const viewer = await addMember(owner, 'viewer')
    const editor = await addMember(owner, 'editor')
    const repository = createMemorySourceSignalRepository(db)
    const created = await repository.create(viewer, signalInput(viewer.principalId))
    const authorDeleted = await repository.create(viewer, signalInput(viewer.principalId))
    await expect(repository.delete(viewer, {
      sourceSignalId: authorDeleted.signal.id,
      reasonCode: 'author_requested_erasure',
    })).resolves.toMatchObject({ status: 'deleted', replayed: false })
    await expect(repository.delete(editor, {
      sourceSignalId: created.signal.id,
      reasonCode: 'editor_attempted_erasure',
    })).rejects.toBeInstanceOf(WorkspacePermissionError)
    const deleted = await repository.delete(owner, {
      sourceSignalId: created.signal.id,
      reasonCode: 'workspace_owner_erasure',
    })
    expect(deleted).toMatchObject({ status: 'deleted', replayed: false })
    await expect(repository.delete(owner, {
      sourceSignalId: created.signal.id,
      reasonCode: 'workspace_owner_erasure',
    })).resolves.toMatchObject({ status: 'deleted', replayed: true })
    expect(await db.select().from(schema.memorySourceSignals)).toEqual([])
    const tombstones = await db.select().from(schema.memorySourceSignalTombstones)
    expect(tombstones).toHaveLength(2)
    expect(JSON.stringify(tombstones)).not.toContain('简洁直接')
    expect(tombstones).toContainEqual(expect.objectContaining({
      sourceSignalId: created.signal.id,
      workspaceId: owner.workspaceId,
      deletedByPrincipalId: owner.principalId,
      reasonCode: 'workspace_owner_erasure',
    }))
    expect(tombstones).toContainEqual(expect.objectContaining({
      sourceSignalId: authorDeleted.signal.id,
      deletedByPrincipalId: viewer.principalId,
      reasonCode: 'author_requested_erasure',
    }))
  })

  it('expires source text by database retention time', async () => {
    const owner = await provision()
    const repository = createMemorySourceSignalRepository(db)
    const created = await repository.create(owner, signalInput(owner.principalId))
    await db.update(schema.memorySourceSignals)
      .set({ retentionUntil: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(schema.memorySourceSignals.id, created.signal.id))
    await expect(repository.inspectExpiryBacklog()).resolves.toEqual({
      signalsDue: 1,
      signalsCapped: false,
    })
    await expect(repository.expireDue()).resolves.toEqual({ signalsDeleted: 1 })
    expect(await db.select().from(schema.memorySourceSignals)).toEqual([])
    expect(await db.select().from(schema.memorySourceSignalTombstones)).toMatchObject([{
      sourceSignalId: created.signal.id,
      deletedByPrincipalId: null,
      reasonCode: 'retention_elapsed',
    }])
    await expect(repository.inspectExpiryBacklog()).resolves.toEqual({
      signalsDue: 0,
      signalsCapped: false,
    })
  })

  it('binds proposals to trusted signal evidence and cascades source erasure through Memory', async () => {
    const owner = await provision()
    const signals = createMemorySourceSignalRepository(db)
    const memories = createMemoryRepository(db)
    const created = await signals.create(owner, signalInput(owner.principalId))
    const proposal = {
      schemaVersion: 2 as const,
      workspaceId: owner.workspaceId,
      subject: { kind: 'principal' as const, key: owner.principalId },
      memoryKey: 'writing.tone',
      kind: 'preference' as const,
      content: 'Prefer concise and direct technical prose.',
      proposedBy: 'model' as const,
      confidence: 0.95,
      sensitivity: 'normal' as const,
      consent: {
        basis: 'explicit_user' as const,
        policyVersion: created.signal.consentPolicyVersion,
      },
      source: {
        kind: 'signal' as const,
        signalId: created.signal.id,
        evidenceFingerprint: created.signal.evidenceFingerprint,
      },
      extractor: { key: 'signal-memory-extractor', version: 'v1' },
      expiresAt: new Date(created.signal.retentionUntil.getTime() - 1_000).toISOString(),
    }
    const submitted = await memories.submitProposal(proposal)
    if (submitted.status !== 'candidate') throw new Error('Expected signal Memory candidate')
    expect(submitted.candidate).toMatchObject({
      sourceKind: 'signal',
      sourceRunId: null,
      sourceSignalId: created.signal.id,
      consentBasis: 'explicit_user',
    })
    const materialized = await memories.reviewCandidate(owner, {
      candidateId: submitted.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_signal_memory',
    })
    expect(materialized).toMatchObject({ status: 'materialized' })

    for (const forged of [
      { ...proposal, memoryKey: 'writing.forged-evidence', source: {
        ...proposal.source, evidenceFingerprint: `sha256:${'f'.repeat(64)}`,
      } },
      { ...proposal, memoryKey: 'writing.forged-subject', subject: {
        kind: 'project' as const, key: 'other-project',
      } },
      { ...proposal, memoryKey: 'writing.forged-consent', consent: {
        basis: 'workspace_policy' as const, policyVersion: 'memory-consent-v1',
      } },
      { ...proposal, memoryKey: 'writing.excess-retention', expiresAt:
        new Date(created.signal.retentionUntil.getTime() + 1_000).toISOString() },
    ]) {
      await expect(memories.submitProposal(forged)).rejects.toThrow(
        'does not match its trusted source signal',
      )
    }

    await signals.delete(owner, {
      sourceSignalId: created.signal.id,
      reasonCode: 'user_revoked_memory_source',
    })
    expect(await db.select().from(schema.memoryCandidates)).toEqual([])
    expect(await db.select().from(schema.memories)).toEqual([])
    expect(await db.select().from(schema.memoryRevisions)).toEqual([])
    expect(await db.select().from(schema.memorySourceSignalTombstones)).toMatchObject([{
      sourceSignalId: created.signal.id,
      reasonCode: 'user_revoked_memory_source',
    }])
  })

  it('cancels before provider reservation and becomes uncertain after reservation while retaining audit', async () => {
    const owner = await provision()
    const signals = createMemorySourceSignalRepository(db)
    const extractions = createMemoryExtractionRepository(db)

    const cancellable = await signals.create(owner, signalInput(owner.principalId))
    const cancelledClaim = await extractions.claimExtraction({
      source: { kind: 'signal', signalId: cancellable.signal.id },
      workerId: 'signal-cancel-worker',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: memoryExecution,
    })
    if (cancelledClaim.status !== 'claimed') throw new Error('Expected cancellable claim')
    await signals.delete(owner, {
      sourceSignalId: cancellable.signal.id,
      reasonCode: 'erased_before_provider',
    })
    expect(await extractions.getExtractionLedger({
      kind: 'signal', signalId: cancellable.signal.id,
    })).toMatchObject({
      task: {
        sourceKind: 'signal',
        sourceId: cancellable.signal.id,
        sourceSignalId: null,
        sourceDeletedAt: expect.any(Date),
        status: 'cancelled',
      },
      attempts: [{ status: 'cancelled', errorCode: 'source_erased' }],
      effects: [],
    })
    await expect(extractions.heartbeatExtraction(cancelledClaim.identity, 30_000))
      .resolves.toBe('lease_lost')

    const uncertain = await signals.create(owner, signalInput(owner.principalId))
    const uncertainClaim = await extractions.claimExtraction({
      source: { kind: 'signal', signalId: uncertain.signal.id },
      workerId: 'signal-uncertain-worker',
      leaseDurationMs: 30_000,
      maxAttempts: 3,
      execution: memoryExecution,
    })
    if (uncertainClaim.status !== 'claimed') throw new Error('Expected uncertain claim')
    const effectKey = 'model:memory-extract:attempt:1'
    await extractions.reserveEffect({
      ...uncertainClaim.identity,
      effectKey,
      requestFingerprint: fingerprintEffectRequest({
        source: { kind: 'signal', signalId: uncertain.signal.id },
        evidenceFingerprint: uncertain.signal.evidenceFingerprint,
      }),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    })
    await signals.delete(owner, {
      sourceSignalId: uncertain.signal.id,
      reasonCode: 'erased_during_provider',
    })
    const ledger = await extractions.getExtractionLedger({
      kind: 'signal', signalId: uncertain.signal.id,
    })
    expect(ledger).toMatchObject({
      task: {
        sourceSignalId: null,
        sourceDeletedAt: expect.any(Date),
        status: 'uncertain',
        errorCode: 'source_erased',
      },
      attempts: [{ status: 'uncertain', errorCode: 'source_erased' }],
      effects: [{ status: 'uncertain', errorCode: 'source_erased' }],
    })
    expect(JSON.stringify(ledger)).not.toContain('简洁直接')
    await expect(extractions.finishEffect({
      ...uncertainClaim.identity,
      effectKey,
      outcome: 'succeeded',
      metadata: { provider: 'scripted', model: 'scripted-memory-v1', latencyMs: 1 },
    })).resolves.toEqual({ status: 'lease_lost' })
  })
})
