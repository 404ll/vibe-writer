import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import {
  fingerprintEvalDataset,
  fingerprintEvalModelExecutionBinding,
  type EvalCase,
  type EvalJsonValue,
  type EvalModelExecutionBinding,
} from '@vibe-writer/eval-core'
import { eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createMemoryCalibrationAuthorizationRepository,
} from '../src/repositories/memory-calibrations'
import {
  WorkspacePermissionError,
  createWorkspaceRepository,
} from '../src/repositories/workspaces'
import * as schema from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
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
      memory_calibration_authorization_events, memory_calibration_authorizations,
      eval_scores, eval_trials, eval_runs, eval_cases, eval_suites, outbox_events,
      workspace_memberships, principal_identities, workspaces, principals CASCADE;
  `)
})

afterAll(async () => {
  await client.close()
})

async function provision(role: 'owner' | 'editor' = 'owner', workspaceId: string = randomUUID()) {
  return createWorkspaceRepository(db).provision({
    principalId: randomUUID(),
    workspaceId,
    slug: `memory-calibration-${randomUUID().slice(0, 8)}`,
    name: 'Memory calibration workspace',
    role,
  })
}

const cases = [
  { key: 'case-a', input: { text: 'A' }, expected: { decision: 'remember' }, tags: ['memory'] },
  { key: 'case-b', input: { text: 'B' }, expected: { decision: 'ignore' }, tags: ['memory'] },
] satisfies Array<EvalCase<EvalJsonValue, EvalJsonValue>>

function registration(overrides: Partial<{
  idempotencyKey: string
  maxCostMicrousd: number
}> = {}) {
  const binding = {
    schemaVersion: 1,
    planKey: 'memory-extraction-live-calibration',
    datasetFingerprint: fingerprintEvalDataset(cases),
    target: {
      provider: 'scripted',
      model: 'scripted-memory-v1',
      modelProfile: 'scripted-memory-calibration-v1',
      promptVersion: 'memory-prompt-v1',
      extractorVersion: 'memory-extractor-v1',
      codeRevision: 'memory-calibration-test',
    },
    generation: { maxOutputTokens: 128 },
    pricing: {
      version: 'scripted-pricing-v1',
      inputMicrousdPerMillionTokens: 1,
      outputMicrousdPerMillionTokens: 2,
      cacheReadMicrousdPerMillionTokens: 0,
      cacheWriteMicrousdPerMillionTokens: 0,
    },
    budget: { maxCalls: 6, maxCostMicrousd: overrides.maxCostMicrousd ?? 100 },
  } satisfies EvalModelExecutionBinding
  const bindingFingerprint = fingerprintEvalModelExecutionBinding(binding)
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'memory-calibration-request-v1',
    suiteKey: 'memory-extraction-live-calibration',
    suiteVersion: 'test-v1',
    name: 'Memory extraction live calibration',
    cases,
    binding,
    baseExecution: {
      modelProfile: binding.target.modelProfile,
      promptVersion: binding.target.promptVersion,
      graphVersion: 'memory-extraction-live-calibration-v1',
      toolVersions: {
        extractor: binding.target.extractorVersion,
        binding: bindingFingerprint,
      },
      codeRevision: binding.target.codeRevision,
    },
    targetKey: 'memory-extraction-live-calibration',
    targetVersion: 'v1',
    trialsPerCase: 3,
  }
}

describe('durable Memory calibration authorization', () => {
  it('requires workspace owner permission and preserves exact registration replay', async () => {
    const owner = await provision()
    const editor = await provision('editor', owner.workspaceId)
    const repository = createMemoryCalibrationAuthorizationRepository(db)
    await expect(repository.register(editor, registration()))
      .rejects.toBeInstanceOf(WorkspacePermissionError)

    const first = await repository.register(owner, registration())
    const replay = await repository.register(owner, registration())
    expect(first).toMatchObject({ created: true, authorization: { status: 'draft' } })
    expect(replay).toMatchObject({
      created: false,
      authorization: { id: first.authorization.id },
    })
    await expect(repository.register(owner, registration({ maxCostMicrousd: 101 })))
      .rejects.toThrow('idempotency collision')
    expect(await repository.listEvents(owner, first.authorization.id)).toMatchObject([
      { sequence: 1, eventType: 'created', actorPrincipalId: owner.principalId },
    ])
  })

  it('binds approval to the immutable fingerprint and atomically creates the queued run', async () => {
    const owner = await provision()
    const repository = createMemoryCalibrationAuthorizationRepository(db)
    const registered = await repository.register(owner, registration())
    const fingerprint = registered.authorization.bindingFingerprint

    await expect(repository.enqueue(owner, {
      authorizationId: registered.authorization.id,
      expectedBindingFingerprint: fingerprint,
    })).rejects.toThrow('must be approved')
    await expect(repository.approve(owner, {
      authorizationId: registered.authorization.id,
      expectedBindingFingerprint: `sha256:${'f'.repeat(64)}`,
      reasonCode: 'operator-reviewed-cost-v1',
    })).rejects.toThrow('fingerprint drifted')

    const approved = await repository.approve(owner, {
      authorizationId: registered.authorization.id,
      expectedBindingFingerprint: fingerprint,
      reasonCode: 'operator-reviewed-cost-v1',
    })
    expect(approved).toMatchObject({
      approved: true,
      authorization: {
        status: 'approved',
        approvedByPrincipalId: owner.principalId,
        approvalReasonCode: 'operator-reviewed-cost-v1',
      },
    })
    expect(approved.authorization.approvalId).toBeTruthy()

    const queued = await repository.enqueue(owner, {
      authorizationId: registered.authorization.id,
      expectedBindingFingerprint: fingerprint,
    })
    expect(queued).toMatchObject({
      enqueued: true,
      authorization: { status: 'enqueued', evalRunId: queued.run.id },
      run: {
        status: 'queued',
        mode: 'queued',
        targetKey: 'memory-extraction-live-calibration',
        trialsPerCase: 3,
      },
    })
    expect(queued.run.executionSnapshot.toolVersions).toMatchObject({
      binding: fingerprint,
      approval: approved.authorization.approvalId,
    })
    expect(await repository.enqueue(owner, {
      authorizationId: registered.authorization.id,
      expectedBindingFingerprint: fingerprint,
    })).toMatchObject({ enqueued: false, run: { id: queued.run.id } })

    const events = await repository.listEvents(owner, registered.authorization.id)
    expect(events.map((event) => [event.sequence, event.eventType])).toEqual([
      [1, 'created'],
      [2, 'approved'],
      [3, 'enqueued'],
    ])
    const outbox = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, queued.run.id))
    expect(outbox).toMatchObject([{
      eventType: 'eval.run.requested',
      payload: { evalRunId: queued.run.id },
    }])
    expect(await repository.getEnqueuedByRunId(queued.run.id)).toMatchObject({
      id: registered.authorization.id,
      status: 'enqueued',
    })
  })
})
