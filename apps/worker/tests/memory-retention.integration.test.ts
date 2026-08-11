import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createMemoryRepository,
  createMemorySourceSignalRepository,
  createWorkspaceRepository,
} from '@vibe-writer/db'
import * as schema from '@vibe-writer/db/schema'
import { MemoryRetentionMaintenanceService } from '../src/memory-retention'

const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
)
let client: PGlite
let db: PgliteDatabase<typeof schema>

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(`
    TRUNCATE TABLE
      memory_extraction_reconciliations, memory_extraction_effects,
      memory_extraction_attempts, memory_extraction_tasks,
      memory_tombstones, memory_candidate_events, memory_revisions, memories,
      memory_candidates, memory_source_signal_tombstones, memory_source_signals,
      outbox_events, workspace_memberships, principal_identities, workspaces,
      principals CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function owner() {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId: randomUUID(),
    slug: `retention-${randomUUID().slice(0, 8)}`,
    name: 'Memory retention workspace',
  })
}

function signalInput(principalId: string, suffix: string) {
  return {
    idempotencyKey: `retention-${suffix}`,
    sourceKind: 'explicit_remember' as const,
    subject: { kind: 'principal' as const, key: principalId },
    text: `Durable Memory retention signal ${suffix}.`,
    consentPolicyVersion: 'memory-consent-v1',
    retentionDays: 30,
  }
}

function service(batchSize = 100, alertThreshold = 1_000) {
  return new MemoryRetentionMaintenanceService(
    createMemorySourceSignalRepository(db),
    createMemoryRepository(db),
    {
      workerId: 'pglite-memory-retention',
      batchSize,
      backlogAlertThreshold: alertThreshold,
    },
  )
}

describe('Memory retention maintenance integration', () => {
  it('erases expired source text and active Memory content while keeping content-free tombstones', async () => {
    const scope = await owner()
    const signals = createMemorySourceSignalRepository(db)
    const memories = createMemoryRepository(db)
    const dueSource = await signals.create(scope, signalInput(scope.principalId, 'due-source'))
    const memorySource = await signals.create(scope, signalInput(scope.principalId, 'due-memory'))
    const proposal = await memories.submitProposal({
      schemaVersion: 2,
      workspaceId: scope.workspaceId,
      subject: { kind: 'principal', key: scope.principalId },
      memoryKey: 'writing.tone',
      kind: 'preference',
      content: 'Prefer concise technical prose.',
      proposedBy: 'model',
      confidence: 0.95,
      sensitivity: 'normal',
      consent: {
        basis: 'explicit_user',
        policyVersion: memorySource.signal.consentPolicyVersion,
      },
      source: {
        kind: 'signal',
        signalId: memorySource.signal.id,
        evidenceFingerprint: memorySource.signal.evidenceFingerprint,
      },
      extractor: { key: 'retention-test-extractor', version: 'v1' },
      expiresAt: new Date(memorySource.signal.retentionUntil.getTime() - 1_000).toISOString(),
    })
    if (proposal.status !== 'candidate') throw new Error('Expected retention candidate')
    const materialized = await memories.reviewCandidate(scope, {
      candidateId: proposal.candidate.id,
      decision: 'materialize',
      reasonCode: 'owner_confirmed_retention_test',
    })
    if (materialized.status !== 'materialized') throw new Error('Expected retention Memory')
    const past = new Date('2000-01-01T00:00:00.000Z')
    await db.update(schema.memorySourceSignals).set({ retentionUntil: past })
      .where(eq(schema.memorySourceSignals.id, dueSource.signal.id))
    await db.update(schema.memories).set({ expiresAt: past })
      .where(eq(schema.memories.id, materialized.memory.id))
    await db.update(schema.memoryCandidates).set({ expiresAt: past })
      .where(eq(schema.memoryCandidates.id, proposal.candidate.id))

    await expect(service().runBatch()).resolves.toMatchObject({
      schemaVersion: 1,
      status: 'progress',
      deleted: { sourceSignals: 1, memories: 1, candidates: 1 },
      remaining: { sampledTotalDue: 0, sampleCapped: false },
    })
    expect(await db.select().from(schema.memories)).toEqual([])
    expect(await db.select().from(schema.memoryRevisions)).toEqual([])
    expect(await db.select().from(schema.memoryCandidates)).toEqual([])
    expect(await db.select().from(schema.memorySourceSignals)).toMatchObject([{
      id: memorySource.signal.id,
    }])
    expect(await db.select().from(schema.memorySourceSignalTombstones)).toMatchObject([{
      sourceSignalId: dueSource.signal.id,
      deletedByPrincipalId: null,
      reasonCode: 'retention_elapsed',
    }])
    expect(await db.select().from(schema.memoryTombstones)).toMatchObject([{
      memoryId: materialized.memory.id,
      deletedByPrincipalId: null,
      reasonCode: 'retention_elapsed',
    }])
    expect(JSON.stringify({
      signals: await db.select().from(schema.memorySourceSignalTombstones),
      memories: await db.select().from(schema.memoryTombstones),
    })).not.toContain('concise technical prose')
  })

  it('exposes remaining due work after a bounded batch and drains it on replay', async () => {
    const scope = await owner()
    const signals = createMemorySourceSignalRepository(db)
    const first = await signals.create(scope, signalInput(scope.principalId, 'first'))
    const second = await signals.create(scope, signalInput(scope.principalId, 'second'))
    const past = new Date('2000-01-01T00:00:00.000Z')
    await db.update(schema.memorySourceSignals).set({ retentionUntil: past })
      .where(eq(schema.memorySourceSignals.id, first.signal.id))
    await db.update(schema.memorySourceSignals).set({ retentionUntil: past })
      .where(eq(schema.memorySourceSignals.id, second.signal.id))
    const maintenance = service(1, 10)
    await expect(maintenance.runBatch()).resolves.toMatchObject({
      deleted: { sourceSignals: 1 },
      remaining: { sourceSignalsDue: 1, sampledTotalDue: 1 },
    })
    await expect(maintenance.runBatch()).resolves.toMatchObject({
      deleted: { sourceSignals: 1 },
      remaining: { sourceSignalsDue: 0, sampledTotalDue: 0 },
    })
    await expect(maintenance.runBatch()).resolves.toMatchObject({
      status: 'idle',
      deleted: { sourceSignals: 0, memories: 0, candidates: 0 },
    })
  })
})
