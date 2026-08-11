import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, count, eq, lte, sql } from 'drizzle-orm'
import {
  createMemoryExtractionRepository,
  createMemoryRepository,
  createMemorySourceSignalRepository,
  createPostgresDatabase,
  createWorkspaceRepository,
  fingerprintEffectRequest,
  type AuthorizedWorkspaceScope,
  type MemoryExtractionExecutionSnapshot,
} from '@vibe-writer/db'
import {
  assertCurrentMemoryRetentionRole,
  memoryRetentionRoleProvisioningStatements,
} from '@vibe-writer/db/memory-retention-role'
import { migrateVibePostgresDatabase } from '@vibe-writer/db/migrations'
import * as schema from '@vibe-writer/db/schema'
import { afterAll, describe, expect, it } from 'vitest'
import { createMemoryRetentionMaintenanceRuntime } from '../src/memory-retention-production'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Memory retention role canary requires ${name}`)
  return value
}

const ownerDatabaseUrl = requiredEnvironment('TEST_DATABASE_OWNER_URL')
const retentionDatabaseUrl = requiredEnvironment('TEST_DATABASE_MEMORY_RETENTION_URL')
const retentionRoleName = requiredEnvironment('TEST_DATABASE_MEMORY_RETENTION_ROLE')
const canaryId = requiredEnvironment('VIBE_WRITER_MEMORY_RETENTION_CANARY_ID')
if (!/^[0-9a-f]{32}$/.test(canaryId) || !/^[a-z][a-z0-9_]{0,62}$/.test(retentionRoleName)) {
  throw new Error('Memory retention role canary identifiers are invalid')
}

const ownerDatabase = createPostgresDatabase(ownerDatabaseUrl, { max: 4 })
const retentionDatabase = createPostgresDatabase(retentionDatabaseUrl, { max: 2 })

const extractionExecution: MemoryExtractionExecutionSnapshot = {
  extractorKey: 'retention-role-canary',
  extractorVersion: 'v1',
  promptVersion: 'memory-extractor-v1',
  consentPolicyVersion: 'memory-consent-v1',
  retentionDays: 30,
  modelProfile: {
    profile: 'scripted-memory',
    provider: 'scripted',
    model: 'scripted-memory-v1',
  },
}

function runCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`))
    })
  })
}

function commandReport(output: string): Record<string, unknown> {
  const line = output.split('\n').findLast((entry) => entry.trim().startsWith('{'))
  if (!line) throw new Error(`Command did not emit a JSON report: ${output}`)
  return JSON.parse(line) as Record<string, unknown>
}

async function provisionOwner(workspace?: AuthorizedWorkspaceScope) {
  return createWorkspaceRepository(ownerDatabase.db).provision({
    principalId: randomUUID(),
    workspaceId: workspace?.workspaceId ?? randomUUID(),
    slug: workspace
      ? `ignored-retention-${randomUUID().slice(0, 8)}`
      : `retention-canary-${canaryId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    name: workspace ? 'Ignored existing workspace' : 'Retention role canary workspace',
    role: 'owner',
  })
}

function signalInput(suffix: string) {
  return {
    idempotencyKey: `retention-role-${suffix}`,
    sourceKind: 'explicit_remember' as const,
    subject: { kind: 'workspace' as const, key: 'default' },
    text: `Remember the retention canary preference ${suffix}.`,
    consentPolicyVersion: 'memory-consent-v1',
    retentionDays: 30,
    sourceRunId: undefined,
  }
}

async function createSignal(scope: AuthorizedWorkspaceScope, suffix: string) {
  return createMemorySourceSignalRepository(ownerDatabase.db).create(
    scope,
    signalInput(suffix),
  )
}

async function createCandidate(
  scope: AuthorizedWorkspaceScope,
  suffix: string,
  memoryKey: string,
) {
  const signal = await createSignal(scope, suffix)
  const result = await createMemoryRepository(ownerDatabase.db).submitProposal({
    schemaVersion: 2,
    workspaceId: scope.workspaceId,
    subject: { kind: 'workspace', key: 'default' },
    memoryKey,
    kind: 'preference',
    content: `Retention canary content ${suffix}.`,
    proposedBy: 'user',
    confidence: 1,
    sensitivity: 'normal',
    consent: {
      basis: 'explicit_user',
      policyVersion: signal.signal.consentPolicyVersion,
    },
    source: {
      kind: 'signal',
      signalId: signal.signal.id,
      evidenceFingerprint: signal.signal.evidenceFingerprint,
    },
    extractor: { key: 'retention-role-canary', version: 'v1' },
    expiresAt: new Date(signal.signal.retentionUntil.getTime() - 1_000).toISOString(),
  })
  if (result.status !== 'candidate') throw new Error('Expected Memory candidate')
  return { signal, candidate: result.candidate }
}

async function waitForRetentionDrain(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [dueSignals, dueMemories, dueCandidates] = await Promise.all([
      ownerDatabase.db.select({ value: count() }).from(schema.memorySourceSignals)
        .where(lte(schema.memorySourceSignals.retentionUntil, sql`clock_timestamp()`)),
      ownerDatabase.db.select({ value: count() }).from(schema.memories)
        .where(lte(schema.memories.expiresAt, sql`clock_timestamp()`)),
      ownerDatabase.db.select({ value: count() }).from(schema.memoryCandidates)
        .where(lte(schema.memoryCandidates.expiresAt, sql`clock_timestamp()`)),
    ])
    if (
      dueSignals[0]?.value === 0 && dueMemories[0]?.value === 0 &&
      dueCandidates[0]?.value === 0
    ) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Memory retention role canary did not drain due records')
}

afterAll(async () => {
  await Promise.allSettled([retentionDatabase.close(), ownerDatabase.close()])
})

describe('real PostgreSQL Memory retention role canary', () => {
  it('verifies exact privileges and drains multiple workspaces without owner access', async () => {
    const [target] = await ownerDatabase.client<{
      database: string
      address: string | null
      comment: string | null
    }[]>`
      SELECT
        current_database() AS database,
        host(inet_server_addr()) AS address,
        shobj_description(oid, 'pg_database') AS comment
      FROM pg_database
      WHERE datname = current_database()
    `
    if (
      target?.address !== '127.0.0.1' ||
      target.comment !== `vibe-writer-memory-retention-canary:${canaryId}`
    ) {
      throw new Error(`Refusing Memory retention canary target ${JSON.stringify(target)}`)
    }

    await migrateVibePostgresDatabase(ownerDatabase.db)
    memoryRetentionRoleProvisioningStatements(retentionRoleName)
    await ownerDatabase.client.unsafe(`CREATE ROLE ${retentionRoleName} LOGIN`)
    const provisionOutput = await runCommand(
      'pnpm',
      ['--filter', '@vibe-writer/db', 'memory-retention-role:provision'],
      {
        ...process.env,
        DATABASE_ADMIN_URL: ownerDatabaseUrl,
        MEMORY_RETENTION_DATABASE_ROLE: retentionRoleName,
      },
    )
    expect(commandReport(provisionOutput)).toMatchObject({
      contractKey: 'memory-retention',
      status: 'provisioned',
    })
    const verifyOutput = await runCommand(
      'pnpm',
      ['--filter', '@vibe-writer/db', 'memory-retention-role:verify'],
      {
        ...process.env,
        DATABASE_MEMORY_RETENTION_URL: retentionDatabaseUrl,
        MEMORY_RETENTION_DATABASE_ROLE: retentionRoleName,
      },
    )
    expect(commandReport(verifyOutput)).toMatchObject({
      contractKey: 'memory-retention',
      status: 'verified',
      bypassRls: true,
      sequencePrivilegeCount: 0,
    })
    await expect(assertCurrentMemoryRetentionRole(
      retentionDatabase.client,
      retentionRoleName,
    )).resolves.toMatchObject({ issues: [] })
    await expect(retentionDatabase.client`SELECT count(*) FROM jobs`).rejects.toThrow()

    const firstWorkspace = await provisionOwner()
    const secondWorkspace = await provisionOwner()
    const runningSignal = await createSignal(firstWorkspace, 'running-effect')
    const crossWorkspaceSignal = await createSignal(secondWorkspace, 'other-workspace')
    const extractions = createMemoryExtractionRepository(ownerDatabase.db)
    const claim = await extractions.claimExtraction({
      source: { kind: 'signal', signalId: runningSignal.signal.id },
      workerId: 'retention-role-canary-extractor',
      leaseDurationMs: 60_000,
      maxAttempts: 3,
      execution: extractionExecution,
    })
    if (claim.status !== 'claimed') throw new Error('Expected running extraction claim')
    const reserved = await extractions.reserveEffect({
      ...claim.identity,
      effectKey: 'model:memory-extract:attempt:1',
      requestFingerprint: fingerprintEffectRequest({
        source: { kind: 'signal', signalId: runningSignal.signal.id },
        attempt: 1,
      }),
      provider: 'scripted',
      model: 'scripted-memory-v1',
    })
    if (reserved.status !== 'reserved') throw new Error('Expected reserved provider effect')

    const active = await createCandidate(firstWorkspace, 'active', 'writing.tone')
    const memories = createMemoryRepository(ownerDatabase.db)
    const materialized = await memories.reviewCandidate(firstWorkspace, {
      candidateId: active.candidate.id,
      decision: 'materialize',
      reasonCode: 'retention_canary_materialize',
    })
    if (materialized.status !== 'materialized') throw new Error('Expected active Memory')
    const pending = await createCandidate(secondWorkspace, 'pending', 'writing.format')

    const past = new Date('2000-01-01T00:00:00.000Z')
    await ownerDatabase.db.update(schema.memorySourceSignals)
      .set({ retentionUntil: past })
      .where(and(
        eq(schema.memorySourceSignals.id, runningSignal.signal.id),
        eq(schema.memorySourceSignals.workspaceId, firstWorkspace.workspaceId),
      ))
    await ownerDatabase.db.update(schema.memorySourceSignals)
      .set({ retentionUntil: past })
      .where(and(
        eq(schema.memorySourceSignals.id, crossWorkspaceSignal.signal.id),
        eq(schema.memorySourceSignals.workspaceId, secondWorkspace.workspaceId),
      ))
    await ownerDatabase.db.update(schema.memories)
      .set({ expiresAt: past })
      .where(eq(schema.memories.id, materialized.memory.id))
    await ownerDatabase.db.update(schema.memoryCandidates)
      .set({ expiresAt: past })
      .where(eq(schema.memoryCandidates.id, pending.candidate.id))

    const runtime = createMemoryRetentionMaintenanceRuntime({
      databaseUrl: retentionDatabaseUrl,
      databaseRole: retentionRoleName,
      workerId: 'retention-role-canary',
      batchSize: 100,
      backlogAlertThreshold: 1_000,
      pollMs: 60_000,
      backlogPollMs: 10,
    })
    try {
      await runtime.start()
      await waitForRetentionDrain()
    } finally {
      await runtime.close()
    }

    expect(await ownerDatabase.db.select().from(schema.memorySourceSignals)
      .where(eq(schema.memorySourceSignals.id, runningSignal.signal.id))).toEqual([])
    expect(await ownerDatabase.db.select().from(schema.memorySourceSignals)
      .where(eq(schema.memorySourceSignals.id, crossWorkspaceSignal.signal.id))).toEqual([])
    expect(await ownerDatabase.db.select().from(schema.memories)
      .where(eq(schema.memories.id, materialized.memory.id))).toEqual([])
    expect(await ownerDatabase.db.select().from(schema.memoryCandidates)
      .where(eq(schema.memoryCandidates.id, pending.candidate.id))).toEqual([])
    expect(await ownerDatabase.db.select().from(schema.memorySourceSignalTombstones))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceSignalId: runningSignal.signal.id,
          workspaceId: firstWorkspace.workspaceId,
          deletedByPrincipalId: null,
          reasonCode: 'retention_elapsed',
        }),
        expect.objectContaining({
          sourceSignalId: crossWorkspaceSignal.signal.id,
          workspaceId: secondWorkspace.workspaceId,
          deletedByPrincipalId: null,
          reasonCode: 'retention_elapsed',
        }),
      ]))
    expect(await ownerDatabase.db.select().from(schema.memoryTombstones)
      .where(eq(schema.memoryTombstones.memoryId, materialized.memory.id)))
      .toMatchObject([{
        workspaceId: firstWorkspace.workspaceId,
        deletedByPrincipalId: null,
        reasonCode: 'retention_elapsed',
      }])
    expect(await ownerDatabase.db.select().from(schema.memoryExtractionTasks)
      .where(eq(schema.memoryExtractionTasks.sourceId, runningSignal.signal.id)))
      .toMatchObject([{
        sourceSignalId: null,
        sourceDeletedAt: expect.any(Date),
        status: 'uncertain',
        errorCode: 'source_erased',
      }])
    expect(await ownerDatabase.db.select().from(schema.memoryExtractionAttempts)
      .where(eq(schema.memoryExtractionAttempts.sourceId, runningSignal.signal.id)))
      .toMatchObject([{ status: 'uncertain', errorCode: 'source_erased' }])
    expect(await ownerDatabase.db.select().from(schema.memoryExtractionEffects)
      .where(eq(schema.memoryExtractionEffects.attemptId, claim.identity.attemptId)))
      .toMatchObject([{ status: 'uncertain', errorCode: 'source_erased' }])
    expect(await ownerDatabase.db.select().from(schema.outboxEvents)
      .where(and(
        eq(schema.outboxEvents.aggregateType, 'memory_extraction'),
        eq(schema.outboxEvents.aggregateId, runningSignal.signal.id),
      )))
      .toMatchObject([{ status: 'failed' }])
  }, 30_000)
})
