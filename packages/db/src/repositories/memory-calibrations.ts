import { randomUUID } from 'node:crypto'
import {
  fingerprintEvalDataset,
  fingerprintEvalModelExecutionBinding,
  fingerprintEvalValue,
  parseEvalModelExecutionBinding,
  type EvalCase,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'
import { and, eq, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { EvalExecutionSnapshot } from '../domain'
import {
  evalCases,
  evalRuns,
  evalSuites,
  memoryCalibrationAuthorizationEvents,
  memoryCalibrationAuthorizations,
  outboxEvents,
} from '../schema'
import type { VibeDatabase } from './jobs'
import {
  requireWorkspaceOwner,
  setWorkspaceSession,
  type AuthorizedWorkspaceScope,
} from './workspaces'

type JsonCase = EvalCase<EvalJsonValue, EvalJsonValue>

export type RegisterMemoryCalibrationAuthorizationInput = {
  idempotencyKey: string
  suiteKey: string
  suiteVersion: string
  name: string
  description?: string
  cases: readonly JsonCase[]
  binding: unknown
  baseExecution: EvalExecutionSnapshot
  targetKey: string
  targetVersion: string
  trialsPerCase: number
}

export type ApproveMemoryCalibrationAuthorizationInput = {
  authorizationId: string
  expectedBindingFingerprint: string
  reasonCode: string
}

export type EnqueueMemoryCalibrationAuthorizationInput = {
  authorizationId: string
  expectedBindingFingerprint: string
}

const MAX_CASE_JSON_BYTES = 1_048_576
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/

function identifier(value: string, name: string, maxLength = 256): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} non-whitespace characters`)
  }
  return normalized
}

function assertFingerprint(value: string, name: string): string {
  if (!FINGERPRINT.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function validateExecution(execution: EvalExecutionSnapshot): EvalExecutionSnapshot {
  const toolVersions = Object.fromEntries(
    Object.entries(execution.toolVersions).map(([name, version]) => [
      identifier(name, 'tool name'),
      identifier(version, 'tool version'),
    ]),
  )
  if (Object.keys(toolVersions).length === 0) throw new Error('baseExecution.toolVersions cannot be empty')
  return {
    modelProfile: identifier(execution.modelProfile, 'baseExecution.modelProfile'),
    promptVersion: identifier(execution.promptVersion, 'baseExecution.promptVersion'),
    graphVersion: identifier(execution.graphVersion, 'baseExecution.graphVersion'),
    toolVersions,
    codeRevision: identifier(execution.codeRevision, 'baseExecution.codeRevision'),
  }
}

function normalizedCases(cases: readonly JsonCase[]): JsonCase[] {
  if (cases.length === 0 || cases.length > 10_000) {
    throw new Error('cases must contain 1-10000 entries')
  }
  return cases.map((evalCase) => {
    const normalized: JsonCase = {
      key: identifier(evalCase.key, 'case.key'),
      input: evalCase.input,
      ...(evalCase.expected === undefined ? {} : { expected: evalCase.expected }),
      tags: [...(evalCase.tags ?? [])]
        .map((tag) => identifier(tag, 'case tag'))
        .sort(),
    }
    for (const [name, value] of [
      ['input', normalized.input],
      ['expected', normalized.expected],
    ] as const) {
      if (value === undefined) continue
      fingerprintEvalValue(value)
      const serialized = JSON.stringify(value)
      if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_CASE_JSON_BYTES) {
        throw new Error(`case ${normalized.key} ${name} exceeds ${MAX_CASE_JSON_BYTES} bytes`)
      }
    }
    return normalized
  })
}

function validateBindingAndExecution(input: {
  binding: unknown
  baseExecution: EvalExecutionSnapshot
  cases: readonly JsonCase[]
  trialsPerCase: number
}) {
  if (!Number.isInteger(input.trialsPerCase) || input.trialsPerCase < 1 || input.trialsPerCase > 20) {
    throw new Error('trialsPerCase must be an integer between 1 and 20')
  }
  const binding = parseEvalModelExecutionBinding(input.binding)
  const bindingFingerprint = fingerprintEvalModelExecutionBinding(binding)
  const datasetFingerprint = fingerprintEvalDataset(input.cases)
  if (binding.datasetFingerprint !== datasetFingerprint) {
    throw new Error('Memory calibration binding does not match the registered dataset')
  }
  if (binding.budget.maxCalls !== input.cases.length * input.trialsPerCase) {
    throw new Error('Memory calibration call budget does not match cases times trials')
  }
  const baseExecution = validateExecution(input.baseExecution)
  if (
    baseExecution.modelProfile !== binding.target.modelProfile ||
    baseExecution.promptVersion !== binding.target.promptVersion ||
    baseExecution.codeRevision !== binding.target.codeRevision ||
    baseExecution.toolVersions.binding !== bindingFingerprint
  ) {
    throw new Error('Memory calibration base execution drifted from its immutable binding')
  }
  if ('approval' in baseExecution.toolVersions) {
    throw new Error('Memory calibration base execution cannot contain approval evidence')
  }
  return { binding, bindingFingerprint, datasetFingerprint, baseExecution }
}

function sameExecution(left: EvalExecutionSnapshot, right: EvalExecutionSnapshot): boolean {
  return fingerprintEvalValue(left) === fingerprintEvalValue(right)
}

export class MemoryCalibrationAuthorizationRepository<
  TQueryResult extends PgQueryResultHKT,
> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async register(
    scope: AuthorizedWorkspaceScope,
    input: RegisterMemoryCalibrationAuthorizationInput,
  ) {
    requireWorkspaceOwner(scope)
    const idempotencyKey = identifier(input.idempotencyKey, 'idempotencyKey', 512)
    const suiteKey = identifier(input.suiteKey, 'suiteKey')
    const suiteVersion = identifier(input.suiteVersion, 'suiteVersion')
    const name = identifier(input.name, 'name', 512)
    const description = input.description?.slice(0, 4_000) ?? ''
    const targetKey = identifier(input.targetKey, 'targetKey')
    const targetVersion = identifier(input.targetVersion, 'targetVersion')
    const cases = normalizedCases(input.cases)
    const validated = validateBindingAndExecution({
      binding: input.binding,
      baseExecution: input.baseExecution,
      cases,
      trialsPerCase: input.trialsPerCase,
    })
    const namespaceKey = `workspace:${scope.workspaceId}:memory-calibration`

    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [createdSuite] = await scoped.insert(evalSuites).values({
        workspaceId: scope.workspaceId,
        namespaceKey,
        suiteKey,
        version: suiteVersion,
        name,
        description,
        status: 'active',
        datasetFingerprint: validated.datasetFingerprint,
      }).onConflictDoNothing().returning()
      let suite = createdSuite
      if (createdSuite) {
        await scoped.insert(evalCases).values(cases.map((evalCase) => ({
          suiteId: createdSuite.id,
          caseKey: evalCase.key,
          input: evalCase.input,
          expected: evalCase.expected ?? null,
          inputFingerprint: fingerprintEvalValue(evalCase.input),
          dataClassification: 'synthetic' as const,
          tags: [...(evalCase.tags ?? [])],
        })))
      } else {
        const [existingSuite] = await scoped.select().from(evalSuites).where(and(
          eq(evalSuites.namespaceKey, namespaceKey),
          eq(evalSuites.suiteKey, suiteKey),
          eq(evalSuites.version, suiteVersion),
        )).limit(1)
        if (!existingSuite) throw new Error('Memory calibration suite idempotent lookup failed')
        const existingCases = await scoped.select().from(evalCases)
          .where(eq(evalCases.suiteId, existingSuite.id))
          .orderBy(evalCases.caseKey)
        const reconstructed = existingCases.map<JsonCase>((evalCase) => ({
          key: evalCase.caseKey,
          input: evalCase.input as EvalJsonValue,
          ...(evalCase.expected === null ? {} : { expected: evalCase.expected as EvalJsonValue }),
          tags: evalCase.tags,
        }))
        if (
          existingSuite.workspaceId !== scope.workspaceId ||
          existingSuite.name !== name ||
          existingSuite.description !== description ||
          existingSuite.status !== 'active' ||
          existingSuite.datasetFingerprint !== validated.datasetFingerprint ||
          fingerprintEvalDataset(reconstructed) !== validated.datasetFingerprint
        ) {
          throw new Error(`Memory calibration suite version collision: ${suiteKey}@${suiteVersion}`)
        }
        suite = existingSuite
      }
      if (!suite) throw new Error('Memory calibration suite registration failed')

      const [created] = await scoped.insert(memoryCalibrationAuthorizations).values({
        workspaceId: scope.workspaceId,
        suiteId: suite.id,
        idempotencyKey,
        status: 'draft',
        bindingSnapshot: validated.binding,
        bindingFingerprint: validated.bindingFingerprint,
        baseExecutionSnapshot: validated.baseExecution,
        targetKey,
        targetVersion,
        trialsPerCase: input.trialsPerCase,
        createdByPrincipalId: scope.principalId,
        nextEventSeq: 2,
      }).onConflictDoNothing().returning()
      if (!created) {
        const [existing] = await scoped.select().from(memoryCalibrationAuthorizations).where(and(
          eq(memoryCalibrationAuthorizations.workspaceId, scope.workspaceId),
          eq(memoryCalibrationAuthorizations.idempotencyKey, idempotencyKey),
        )).limit(1)
        if (!existing) throw new Error('Memory calibration authorization idempotent lookup failed')
        if (
          existing.suiteId !== suite.id ||
          existing.bindingFingerprint !== validated.bindingFingerprint ||
          fingerprintEvalValue(existing.bindingSnapshot) !== fingerprintEvalValue(validated.binding) ||
          !sameExecution(existing.baseExecutionSnapshot, validated.baseExecution) ||
          existing.targetKey !== targetKey ||
          existing.targetVersion !== targetVersion ||
          existing.trialsPerCase !== input.trialsPerCase ||
          existing.createdByPrincipalId !== scope.principalId
        ) {
          throw new Error(`Memory calibration authorization idempotency collision: ${idempotencyKey}`)
        }
        return { authorization: existing, created: false }
      }
      await scoped.insert(memoryCalibrationAuthorizationEvents).values({
        authorizationId: created.id,
        workspaceId: scope.workspaceId,
        sequence: 1,
        eventType: 'created',
        actorPrincipalId: scope.principalId,
        bindingFingerprint: validated.bindingFingerprint,
      })
      return { authorization: created, created: true }
    })
  }

  async approve(
    scope: AuthorizedWorkspaceScope,
    input: ApproveMemoryCalibrationAuthorizationInput,
  ) {
    requireWorkspaceOwner(scope)
    const authorizationId = identifier(input.authorizationId, 'authorizationId')
    const expectedBindingFingerprint = assertFingerprint(
      input.expectedBindingFingerprint,
      'expectedBindingFingerprint',
    )
    const reasonCode = identifier(input.reasonCode, 'reasonCode')
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [current] = await scoped.select().from(memoryCalibrationAuthorizations).where(and(
        eq(memoryCalibrationAuthorizations.id, authorizationId),
        eq(memoryCalibrationAuthorizations.workspaceId, scope.workspaceId),
      )).for('update').limit(1)
      if (!current) throw new Error('Memory calibration authorization not found in workspace')
      if (current.bindingFingerprint !== expectedBindingFingerprint) {
        throw new Error('Memory calibration approval binding fingerprint drifted')
      }
      if (current.status !== 'draft') {
        if (
          current.approvedByPrincipalId !== scope.principalId ||
          current.approvalReasonCode !== reasonCode
        ) {
          throw new Error('Memory calibration approval replay collision')
        }
        return { authorization: current, approved: false }
      }
      const approvalId = randomUUID()
      const [approved] = await scoped.update(memoryCalibrationAuthorizations).set({
        status: 'approved',
        approvalId,
        approvedByPrincipalId: scope.principalId,
        approvalReasonCode: reasonCode,
        approvedAt: sql`clock_timestamp()`,
        nextEventSeq: current.nextEventSeq + 1,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(memoryCalibrationAuthorizations.id, current.id),
        eq(memoryCalibrationAuthorizations.status, 'draft'),
      )).returning()
      if (!approved) throw new Error('Memory calibration authorization approval race')
      await scoped.insert(memoryCalibrationAuthorizationEvents).values({
        authorizationId: approved.id,
        workspaceId: scope.workspaceId,
        sequence: current.nextEventSeq,
        eventType: 'approved',
        actorPrincipalId: scope.principalId,
        bindingFingerprint: approved.bindingFingerprint,
        reasonCode,
      })
      return { authorization: approved, approved: true }
    })
  }

  async enqueue(
    scope: AuthorizedWorkspaceScope,
    input: EnqueueMemoryCalibrationAuthorizationInput,
  ) {
    requireWorkspaceOwner(scope)
    const authorizationId = identifier(input.authorizationId, 'authorizationId')
    const expectedBindingFingerprint = assertFingerprint(
      input.expectedBindingFingerprint,
      'expectedBindingFingerprint',
    )
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [current] = await scoped.select().from(memoryCalibrationAuthorizations).where(and(
        eq(memoryCalibrationAuthorizations.id, authorizationId),
        eq(memoryCalibrationAuthorizations.workspaceId, scope.workspaceId),
      )).for('update').limit(1)
      if (!current) throw new Error('Memory calibration authorization not found in workspace')
      if (current.bindingFingerprint !== expectedBindingFingerprint) {
        throw new Error('Memory calibration enqueue binding fingerprint drifted')
      }
      if (current.status === 'enqueued') {
        const [run] = await scoped.select().from(evalRuns)
          .where(eq(evalRuns.id, current.evalRunId!)).limit(1)
        if (!run) throw new Error('Memory calibration enqueued run is missing')
        return { authorization: current, run, enqueued: false }
      }
      if (current.status !== 'approved' || !current.approvalId) {
        throw new Error('Memory calibration authorization must be approved before enqueue')
      }
      const [suite] = await scoped.select().from(evalSuites).where(and(
        eq(evalSuites.id, current.suiteId),
        eq(evalSuites.workspaceId, scope.workspaceId),
      )).limit(1)
      if (!suite || suite.status !== 'active' || suite.datasetFingerprint !== current.bindingSnapshot.datasetFingerprint) {
        throw new Error('Memory calibration suite is no longer an active immutable dataset')
      }
      const rows = await scoped.select().from(evalCases).where(eq(evalCases.suiteId, suite.id))
        .orderBy(evalCases.caseKey)
      const reconstructed = rows.map<JsonCase>((evalCase) => ({
        key: evalCase.caseKey,
        input: evalCase.input as EvalJsonValue,
        ...(evalCase.expected === null ? {} : { expected: evalCase.expected as EvalJsonValue }),
        tags: evalCase.tags,
      }))
      if (fingerprintEvalDataset(reconstructed) !== suite.datasetFingerprint) {
        throw new Error('Memory calibration suite cases drifted before enqueue')
      }
      const executionSnapshot: EvalExecutionSnapshot = {
        ...current.baseExecutionSnapshot,
        toolVersions: {
          ...current.baseExecutionSnapshot.toolVersions,
          approval: current.approvalId,
        },
      }
      const [run] = await scoped.insert(evalRuns).values({
        suiteId: suite.id,
        status: 'queued',
        mode: 'queued',
        idempotencyKey: `memory-calibration:${current.id}`,
        trigger: 'manual',
        targetKey: current.targetKey,
        targetVersion: current.targetVersion,
        executionSnapshot,
        datasetFingerprint: suite.datasetFingerprint,
        trialsPerCase: current.trialsPerCase,
        startedAt: null,
      }).returning()
      if (!run) throw new Error('Memory calibration Eval run creation failed')
      await scoped.insert(outboxEvents).values({
        idempotencyKey: `eval:${run.id}:enqueue:v1`,
        aggregateType: 'eval_run',
        aggregateId: run.id,
        eventType: 'eval.run.requested',
        payload: { evalRunId: run.id },
      })
      const [enqueued] = await scoped.update(memoryCalibrationAuthorizations).set({
        status: 'enqueued',
        evalRunId: run.id,
        nextEventSeq: current.nextEventSeq + 1,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(memoryCalibrationAuthorizations.id, current.id),
        eq(memoryCalibrationAuthorizations.status, 'approved'),
      )).returning()
      if (!enqueued) throw new Error('Memory calibration enqueue race')
      await scoped.insert(memoryCalibrationAuthorizationEvents).values({
        authorizationId: enqueued.id,
        workspaceId: scope.workspaceId,
        sequence: current.nextEventSeq,
        eventType: 'enqueued',
        actorPrincipalId: scope.principalId,
        bindingFingerprint: enqueued.bindingFingerprint,
        evalRunId: run.id,
      })
      return { authorization: enqueued, run, enqueued: true }
    })
  }

  async listEvents(scope: AuthorizedWorkspaceScope, authorizationId: string) {
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      return scoped.select().from(memoryCalibrationAuthorizationEvents).where(and(
        eq(memoryCalibrationAuthorizationEvents.workspaceId, scope.workspaceId),
        eq(memoryCalibrationAuthorizationEvents.authorizationId, authorizationId),
      )).orderBy(memoryCalibrationAuthorizationEvents.sequence)
    })
  }

  async getEnqueuedByRunId(evalRunId: string) {
    const [authorization] = await this.db.select().from(memoryCalibrationAuthorizations).where(and(
      eq(memoryCalibrationAuthorizations.evalRunId, identifier(evalRunId, 'evalRunId')),
      eq(memoryCalibrationAuthorizations.status, 'enqueued'),
    )).limit(1)
    return authorization ?? null
  }
}

export function createMemoryCalibrationAuthorizationRepository<
  TQueryResult extends PgQueryResultHKT,
>(db: VibeDatabase<TQueryResult>) {
  return new MemoryCalibrationAuthorizationRepository(db)
}
