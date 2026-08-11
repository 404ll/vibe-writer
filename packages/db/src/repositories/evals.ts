import { randomUUID } from 'node:crypto'
import {
  fingerprintEvalDataset,
  fingerprintEvalValue,
  type EvalCase,
  type EvalJsonValue,
  type EvalRunReport,
  type EvalScoreRecord,
  type EvalTrialRecord,
} from '@vibe-writer/eval-core'
import { and, count, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type {
  EvalDataClassification,
  EvalExecutionSnapshot,
  EvalRunTrigger,
  EvalSuiteStatus,
} from '../domain'
import {
  evalCases,
  evalCandidates,
  evalRuns,
  evalScores,
  evalSuites,
  evalTrials,
  outboxEvents,
} from '../schema'
import type { VibeDatabase } from './jobs'

type JsonCase = EvalCase<EvalJsonValue, EvalJsonValue>

export type CreateEvalSuiteInput = {
  namespaceKey: string
  suiteKey: string
  version: string
  name: string
  description?: string
  status?: EvalSuiteStatus
  dataClassification: EvalDataClassification
  cases: readonly JsonCase[]
}

export type StartEvalRunInput = {
  namespaceKey: string
  suiteKey: string
  suiteVersion: string
  datasetFingerprint: string
  trigger: EvalRunTrigger
  targetKey: string
  targetVersion: string
  execution: EvalExecutionSnapshot
  trialsPerCase: number
}

export type EnqueueEvalRunInput = StartEvalRunInput & {
  idempotencyKey: string
}

export type EvalRunLeaseIdentity = {
  evalRunId: string
  leaseToken: string
}

export type ClaimEvalRunInput = {
  evalRunId: string
  workerId: string
  leaseDurationMs: number
}

export type CommitEvalRunReportInput<TOutput = unknown> = EvalRunLeaseIdentity & {
  report: EvalRunReport<TOutput>
}

export type RecordEvalTrialInput<TOutput = unknown> = {
  evalRunId: string
  trial: EvalTrialRecord<TOutput>
  sourceRunId?: string
}

const MAX_ERROR_LENGTH = 1_000
const MAX_CASE_JSON_BYTES = 1_048_576
const MAX_SCORE_METADATA_BYTES = 16_384
const MAX_CAPTURED_OUTPUT_BYTES = 1_048_576

function identifier(value: string, name: string, maxLength = 256): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} non-whitespace characters`)
  }
  return normalized
}

function boundedError(value: string | undefined): string | null {
  return value ? value.slice(0, MAX_ERROR_LENGTH) : null
}

function assertJsonSize(value: unknown, name: string, maxBytes: number): void {
  fingerprintEvalValue(value)
  const serialized = JSON.stringify(value)
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${name} exceeds ${maxBytes} bytes`)
  }
}

function validDate(value: string, name: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be an ISO timestamp`)
  return date
}

function validateExecution(execution: EvalExecutionSnapshot): EvalExecutionSnapshot {
  const toolVersions = Object.fromEntries(
    Object.entries(execution.toolVersions).map(([name, version]) => [
      identifier(name, 'tool name'),
      identifier(version, 'tool version'),
    ]),
  )
  if (Object.keys(toolVersions).length === 0) throw new Error('execution.toolVersions cannot be empty')
  return {
    modelProfile: identifier(execution.modelProfile, 'execution.modelProfile'),
    promptVersion: identifier(execution.promptVersion, 'execution.promptVersion'),
    graphVersion: identifier(execution.graphVersion, 'execution.graphVersion'),
    toolVersions,
    codeRevision: identifier(execution.codeRevision, 'execution.codeRevision'),
  }
}

function trialFingerprint<TOutput>(trial: EvalTrialRecord<TOutput>): string {
  return fingerprintEvalValue({
    caseKey: trial.caseKey,
    trialIndex: trial.trialIndex,
    status: trial.status,
    ...(trial.outputFingerprint ? { outputFingerprint: trial.outputFingerprint } : {}),
    scores: trial.scores,
    ...(trial.errorCode ? { errorCode: trial.errorCode } : {}),
    ...(trial.errorMessage ? { errorMessage: trial.errorMessage } : {}),
    startedAt: trial.startedAt,
    finishedAt: trial.finishedAt,
  })
}

function scoreValues(trialId: string, score: EvalScoreRecord) {
  if (score.metadata) assertJsonSize(score.metadata, 'score.metadata', MAX_SCORE_METADATA_BYTES)
  const metering = score.modelMetering
  if (metering) {
    for (const [name, value] of Object.entries({
      inputTokens: metering.inputTokens,
      outputTokens: metering.outputTokens,
      cacheReadInputTokens: metering.cacheReadInputTokens,
      cacheWriteInputTokens: metering.cacheWriteInputTokens,
      costMicrousd: metering.costMicrousd,
    })) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
        throw new Error(`score.modelMetering.${name} must fit a non-negative PostgreSQL integer`)
      }
    }
  }
  return {
    trialId,
    evaluatorKey: identifier(score.evaluatorKey, 'score.evaluatorKey'),
    evaluatorVersion: identifier(score.evaluatorVersion, 'score.evaluatorVersion'),
    metric: identifier(score.metric, 'score.metric'),
    status: score.status,
    value: score.value ?? null,
    passed: score.passed ?? null,
    metadata: score.metadata ?? null,
    provider: metering ? identifier(metering.provider, 'score.modelMetering.provider') : null,
    model: metering ? identifier(metering.model, 'score.modelMetering.model') : null,
    providerRequestId: metering?.providerRequestId
      ? identifier(metering.providerRequestId, 'score.modelMetering.providerRequestId')
      : null,
    providerResponseId: metering?.providerResponseId
      ? identifier(metering.providerResponseId, 'score.modelMetering.providerResponseId')
      : null,
    inputTokens: metering?.inputTokens ?? null,
    outputTokens: metering?.outputTokens ?? null,
    cacheReadInputTokens: metering?.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: metering?.cacheWriteInputTokens ?? null,
    costMicrousd: metering?.costMicrousd ?? null,
    pricingVersion: metering
      ? identifier(metering.pricingVersion, 'score.modelMetering.pricingVersion')
      : null,
    costCurrency: metering?.costCurrency ?? null,
    errorCode: boundedError(score.errorCode),
    errorMessage: score.status === 'error' ? 'Eval evaluator failed.' : null,
  }
}

export class EvalRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  private async loadValidatedCases(suite: typeof evalSuites.$inferSelect) {
    const cases = await this.db
      .select()
      .from(evalCases)
      .where(eq(evalCases.suiteId, suite.id))
    if (cases.length === 0) throw new Error('Eval suite has no remaining cases')
    const normalized = cases.map<JsonCase>((evalCase) => ({
      key: evalCase.caseKey,
      input: evalCase.input as EvalJsonValue,
      ...(evalCase.expected === null
        ? {}
        : { expected: evalCase.expected as EvalJsonValue }),
      tags: evalCase.tags,
    }))
    if (
      fingerprintEvalDataset(normalized) !== suite.datasetFingerprint ||
      cases.some(
        (evalCase) =>
          fingerprintEvalValue(evalCase.input) !== evalCase.inputFingerprint,
      )
    ) {
      throw new Error('Eval suite cases no longer match the immutable dataset fingerprint')
    }
    const liveCases = cases.filter((evalCase) => evalCase.sourceCandidateId !== null)
    if (liveCases.length > 0) {
      const [expiredCaseCount] = await this.db
        .select({ value: count() })
        .from(evalCases)
        .where(and(
          eq(evalCases.suiteId, suite.id),
          isNotNull(evalCases.sourceCandidateId),
          lte(evalCases.retentionUntil, sql`clock_timestamp()`),
        ))
      if (!suite.workspaceId || expiredCaseCount?.value !== 0) {
        throw new Error('Eval suite contains expired live materialization')
      }
      const candidateIds = liveCases.map((evalCase) => evalCase.sourceCandidateId!)
      const candidates = await this.db
        .select({
          id: evalCandidates.id,
          workspaceId: evalCandidates.workspaceId,
          status: evalCandidates.status,
          retentionUntil: evalCandidates.retentionUntil,
        })
        .from(evalCandidates)
        .where(and(
          inArray(evalCandidates.id, candidateIds),
          eq(evalCandidates.status, 'materialized'),
          gt(evalCandidates.retentionUntil, sql`clock_timestamp()`),
        ))
      if (
        candidates.length !== candidateIds.length ||
        candidates.some(
          (candidate) =>
            candidate.workspaceId !== suite.workspaceId ||
            candidate.status !== 'materialized',
        )
      ) {
        throw new Error('Eval suite live candidate governance is no longer valid')
      }
    }
    return { rows: cases, cases: normalized }
  }

  private async resolveActiveSuite(input: StartEvalRunInput) {
    if (!Number.isInteger(input.trialsPerCase) || input.trialsPerCase < 1 || input.trialsPerCase > 20) {
      throw new Error('trialsPerCase must be an integer between 1 and 20')
    }
    const [suite] = await this.db
      .select()
      .from(evalSuites)
      .where(and(
        eq(evalSuites.namespaceKey, identifier(input.namespaceKey, 'namespaceKey')),
        eq(evalSuites.suiteKey, identifier(input.suiteKey, 'suiteKey')),
        eq(evalSuites.version, identifier(input.suiteVersion, 'suiteVersion')),
      ))
      .limit(1)
    if (!suite) throw new Error('Eval suite not found')
    if (suite.status !== 'active') throw new Error('Eval suite must be active before it can run')
    if (suite.datasetFingerprint !== input.datasetFingerprint) {
      throw new Error('Eval dataset fingerprint does not match the registered suite')
    }
    await this.loadValidatedCases(suite)
    return {
      suite,
      values: {
        suiteId: suite.id,
        trigger: input.trigger,
        targetKey: identifier(input.targetKey, 'targetKey'),
        targetVersion: identifier(input.targetVersion, 'targetVersion'),
        executionSnapshot: validateExecution(input.execution),
        datasetFingerprint: input.datasetFingerprint,
        trialsPerCase: input.trialsPerCase,
      },
    }
  }

  async createSuite(input: CreateEvalSuiteInput) {
    if (input.dataClassification === 'user_content') {
      throw new Error('User-content Eval suites must use governed materialization')
    }
    if (input.cases.length === 0) throw new Error('Eval suite requires at least one case')
    if (input.cases.length > 10_000) throw new Error('Eval suite cannot exceed 10000 cases')
    const namespaceKey = identifier(input.namespaceKey, 'namespaceKey')
    const suiteKey = identifier(input.suiteKey, 'suiteKey')
    const version = identifier(input.version, 'version')
    const name = identifier(input.name, 'name', 512)
    const description = input.description?.slice(0, 4_000) ?? ''
    const status = input.status ?? 'draft'
    const cases = input.cases.map((evalCase) => ({
      ...evalCase,
      key: identifier(evalCase.key, 'case.key'),
      tags: [...(evalCase.tags ?? [])].map((tag) => identifier(tag, 'case tag')).sort(),
    }))
    for (const evalCase of cases) {
      if (evalCase.tags.length > 50) throw new Error('Eval case cannot exceed 50 tags')
      assertJsonSize(evalCase.input, `case ${evalCase.key} input`, MAX_CASE_JSON_BYTES)
      if (evalCase.expected !== undefined) {
        assertJsonSize(evalCase.expected, `case ${evalCase.key} expected`, MAX_CASE_JSON_BYTES)
      }
    }
    const datasetFingerprint = fingerprintEvalDataset(cases)

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(evalSuites)
        .values({
          namespaceKey,
          suiteKey,
          version,
          name,
          description,
          status,
          datasetFingerprint,
        })
        .onConflictDoNothing()
        .returning()

      if (!created) {
        const [existing] = await tx
          .select()
          .from(evalSuites)
          .where(and(
            eq(evalSuites.namespaceKey, namespaceKey),
            eq(evalSuites.suiteKey, suiteKey),
            eq(evalSuites.version, version),
          ))
          .limit(1)
        if (!existing) throw new Error('Eval suite idempotent lookup failed')
        const existingCases = await tx
          .select({ dataClassification: evalCases.dataClassification })
          .from(evalCases)
          .where(eq(evalCases.suiteId, existing.id))
        if (
          existing.datasetFingerprint !== datasetFingerprint ||
          existing.name !== name ||
          existing.description !== description ||
          existing.status !== status ||
          existingCases.length !== cases.length ||
          existingCases.some(
            (evalCase) => evalCase.dataClassification !== input.dataClassification,
          )
        ) {
          throw new Error(`Eval suite version collision: ${suiteKey}@${version}`)
        }
        return { suite: existing, created: false }
      }

      await tx.insert(evalCases).values(cases.map((evalCase) => ({
        suiteId: created.id,
        caseKey: evalCase.key,
        input: evalCase.input,
        expected: evalCase.expected ?? null,
        inputFingerprint: fingerprintEvalValue(evalCase.input),
        dataClassification: input.dataClassification,
        tags: evalCase.tags,
      })))
      return { suite: created, created: true }
    })
  }

  async startRun(input: StartEvalRunInput) {
    const resolved = await this.resolveActiveSuite(input)
    const [run] = await this.db
      .insert(evalRuns)
      .values({
        ...resolved.values,
        mode: 'inline',
        status: 'running',
        startedAt: new Date(),
      })
      .returning()
    if (!run) throw new Error('Eval run creation failed')
    return run
  }

  async enqueueRun(input: EnqueueEvalRunInput) {
    const resolved = await this.resolveActiveSuite(input)
    const idempotencyKey = identifier(input.idempotencyKey, 'idempotencyKey', 512)
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(evalRuns)
        .values({
          ...resolved.values,
          mode: 'queued',
          status: 'queued',
          idempotencyKey,
          startedAt: null,
        })
        .onConflictDoNothing()
        .returning()
      if (!created) {
        const [existing] = await tx
          .select()
          .from(evalRuns)
          .where(and(
            eq(evalRuns.suiteId, resolved.suite.id),
            eq(evalRuns.idempotencyKey, idempotencyKey),
          ))
          .limit(1)
        if (!existing) throw new Error('Queued Eval run idempotent lookup failed')
        if (
          existing.mode !== 'queued' ||
          existing.trigger !== resolved.values.trigger ||
          existing.targetKey !== resolved.values.targetKey ||
          existing.targetVersion !== resolved.values.targetVersion ||
          existing.datasetFingerprint !== resolved.values.datasetFingerprint ||
          existing.trialsPerCase !== resolved.values.trialsPerCase ||
          fingerprintEvalValue(existing.executionSnapshot) !==
            fingerprintEvalValue(resolved.values.executionSnapshot)
        ) {
          throw new Error(`Queued Eval run idempotency collision: ${idempotencyKey}`)
        }
        return { run: existing, created: false }
      }
      await tx.insert(outboxEvents).values({
        idempotencyKey: `eval:${created.id}:enqueue:v1`,
        aggregateType: 'eval_run',
        aggregateId: created.id,
        eventType: 'eval.run.requested',
        payload: { evalRunId: created.id },
      })
      return { run: created, created: true }
    })
  }

  async getRun(evalRunId: string) {
    const [run] = await this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.id, evalRunId))
      .limit(1)
    return run ?? null
  }

  async claimRun(input: ClaimEvalRunInput) {
    const workerId = identifier(input.workerId, 'workerId')
    if (!Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive integer')
    }
    const leaseToken = randomUUID()
    const [run] = await this.db
      .update(evalRuns)
      .set({
        status: 'running',
        attempt: sql`${evalRuns.attempt} + 1`,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: sql`clock_timestamp() + (${input.leaseDurationMs} * interval '1 millisecond')`,
        heartbeatAt: sql`clock_timestamp()`,
        startedAt: sql`coalesce(${evalRuns.startedAt}, clock_timestamp())`,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(
        eq(evalRuns.id, input.evalRunId),
        eq(evalRuns.mode, 'queued'),
        or(
          eq(evalRuns.status, 'queued'),
          and(
            eq(evalRuns.status, 'running'),
            lte(evalRuns.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        ),
      ))
      .returning()
    if (run) return { status: 'claimed' as const, run }
    const current = await this.getRun(input.evalRunId)
    if (!current) return { status: 'not_found' as const }
    return current.status === 'queued' || current.status === 'running'
      ? { status: 'busy' as const }
      : { status: 'terminal' as const }
  }

  async heartbeatRun(identity: EvalRunLeaseIdentity, leaseDurationMs: number) {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error('leaseDurationMs must be a positive integer')
    }
    const [run] = await this.db
      .update(evalRuns)
      .set({
        leaseExpiresAt: sql`clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`,
        heartbeatAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(
        eq(evalRuns.id, identity.evalRunId),
        eq(evalRuns.mode, 'queued'),
        eq(evalRuns.status, 'running'),
        eq(evalRuns.leaseToken, identity.leaseToken),
        gt(evalRuns.leaseExpiresAt, sql`clock_timestamp()`),
      ))
      .returning({ id: evalRuns.id })
    return run ? 'renewed' as const : 'lease_lost' as const
  }

  async getClaimContext(identity: EvalRunLeaseIdentity) {
    const [run] = await this.db
      .select()
      .from(evalRuns)
      .where(and(
        eq(evalRuns.id, identity.evalRunId),
        eq(evalRuns.mode, 'queued'),
        eq(evalRuns.status, 'running'),
        eq(evalRuns.leaseToken, identity.leaseToken),
        gt(evalRuns.leaseExpiresAt, sql`clock_timestamp()`),
      ))
      .limit(1)
    if (!run) return null
    const [suite] = await this.db
      .select()
      .from(evalSuites)
      .where(eq(evalSuites.id, run.suiteId))
      .limit(1)
    if (!suite) throw new Error('Queued Eval suite disappeared')
    const { rows: cases } = await this.loadValidatedCases(suite)
    return {
      run,
      suite,
      cases: cases.map<JsonCase>((evalCase) => ({
        key: evalCase.caseKey,
        input: evalCase.input as EvalJsonValue,
        ...(evalCase.expected === null
          ? {}
          : { expected: evalCase.expected as EvalJsonValue }),
        tags: evalCase.tags,
      })),
    }
  }

  async commitClaimedReport<TOutput>(input: CommitEvalRunReportInput<TOutput>) {
    fingerprintEvalValue(input.report)
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.id, input.evalRunId))
        .for('update')
        .limit(1)
      if (
        !run || run.mode !== 'queued' || run.status !== 'running' ||
        run.leaseToken !== input.leaseToken || !run.leaseExpiresAt
      ) {
        return { status: 'lease_lost' as const }
      }
      const [active] = await tx
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(and(
          eq(evalRuns.id, run.id),
          eq(evalRuns.leaseToken, input.leaseToken),
          gt(evalRuns.leaseExpiresAt, sql`clock_timestamp()`),
        ))
        .limit(1)
      if (!active) return { status: 'lease_lost' as const }
      const [suite] = await tx
        .select()
        .from(evalSuites)
        .where(eq(evalSuites.id, run.suiteId))
        .limit(1)
      if (!suite) throw new Error('Queued Eval suite disappeared')
      const cases = await tx
        .select()
        .from(evalCases)
        .where(eq(evalCases.suiteId, suite.id))
      const normalizedCases = cases.map<JsonCase>((evalCase) => ({
        key: evalCase.caseKey,
        input: evalCase.input as EvalJsonValue,
        ...(evalCase.expected === null
          ? {}
          : { expected: evalCase.expected as EvalJsonValue }),
        tags: evalCase.tags,
      }))
      if (
        cases.length === 0 ||
        fingerprintEvalDataset(normalizedCases) !== suite.datasetFingerprint ||
        suite.datasetFingerprint !== run.datasetFingerprint ||
        cases.some(
          (evalCase) =>
            fingerprintEvalValue(evalCase.input) !== evalCase.inputFingerprint,
        )
      ) {
        throw new Error('Queued Eval suite changed before report commit')
      }
      const liveCases = cases.filter((evalCase) => evalCase.sourceCandidateId !== null)
      if (liveCases.length > 0) {
        const candidateIds = liveCases.map((evalCase) => evalCase.sourceCandidateId!)
        const validCandidates = await tx
          .select({ id: evalCandidates.id })
          .from(evalCandidates)
          .where(and(
            inArray(evalCandidates.id, candidateIds),
            eq(evalCandidates.status, 'materialized'),
            gt(evalCandidates.retentionUntil, sql`clock_timestamp()`),
          ))
        const [validCaseCount] = await tx
          .select({ value: count() })
          .from(evalCases)
          .where(and(
            eq(evalCases.suiteId, suite.id),
            isNotNull(evalCases.sourceCandidateId),
            gt(evalCases.retentionUntil, sql`clock_timestamp()`),
          ))
        if (
          !suite.workspaceId ||
          validCandidates.length !== liveCases.length ||
          validCaseCount?.value !== liveCases.length
        ) {
          throw new Error('Queued Eval live materialization expired before report commit')
        }
      }
      const report = input.report
      if (
        report.suite.key !== suite.suiteKey ||
        report.suite.version !== suite.version ||
        report.suite.datasetFingerprint !== run.datasetFingerprint ||
        report.target.key !== run.targetKey ||
        report.target.version !== run.targetVersion ||
        fingerprintEvalValue(report.target.execution) !==
          fingerprintEvalValue(run.executionSnapshot) ||
        report.trialsPerCase !== run.trialsPerCase
      ) {
        throw new Error('Queued Eval report identity does not match its request')
      }
      const expectedTrialCount = cases.length * run.trialsPerCase
      if (report.trials.length !== expectedTrialCount) {
        throw new Error(`Queued Eval report is incomplete: expected ${expectedTrialCount} trials`)
      }
      const casesByKey = new Map(cases.map((evalCase) => [evalCase.caseKey, evalCase]))
      const missingTrials = new Set(cases.flatMap((evalCase) =>
        Array.from(
          { length: run.trialsPerCase },
          (_, trialIndex) => `${evalCase.caseKey}:${trialIndex}`,
        ),
      ))
      let reportHasErrors = false
      for (const trial of report.trials) {
        const evalCase = casesByKey.get(identifier(trial.caseKey, 'trial.caseKey'))
        if (!evalCase) throw new Error('Queued Eval trial does not belong to its suite')
        const trialIdentity = `${trial.caseKey}:${trial.trialIndex}`
        if (!missingTrials.delete(trialIdentity)) {
          throw new Error(`Unexpected or duplicate queued Eval trial ${trialIdentity}`)
        }
        reportHasErrors ||= trial.status === 'error' ||
          trial.scores.some((score) => score.status === 'error')
        const startedAt = validDate(trial.startedAt, 'trial.startedAt')
        const finishedAt = validDate(trial.finishedAt, 'trial.finishedAt')
        if (finishedAt < startedAt) throw new Error('trial.finishedAt cannot precede startedAt')
        if (trial.output !== undefined) {
          assertJsonSize(trial.output, 'trial.output', MAX_CAPTURED_OUTPUT_BYTES)
        }
        const [created] = await tx
          .insert(evalTrials)
          .values({
            evalRunId: run.id,
            caseId: evalCase.id,
            trialIndex: trial.trialIndex,
            status: trial.status,
            output: trial.output ?? null,
            outputFingerprint: trial.outputFingerprint ?? null,
            recordFingerprint: trialFingerprint(trial),
            errorCode: boundedError(trial.errorCode),
            errorMessage: trial.status === 'error' ? 'Eval target execution failed.' : null,
            startedAt,
            finishedAt,
          })
          .returning({ id: evalTrials.id })
        if (!created) throw new Error(`Queued Eval trial insert failed: ${trialIdentity}`)
        if (trial.scores.length > 0) {
          await tx.insert(evalScores).values(
            trial.scores.map((score) => scoreValues(created.id, score)),
          )
        }
      }
      if (missingTrials.size > 0) throw new Error('Queued Eval report is missing expected trials')
      if (report.status !== (reportHasErrors ? 'failed' : 'completed')) {
        throw new Error('Queued Eval report status does not match its trial and score results')
      }
      const [finished] = await tx
        .update(evalRuns)
        .set({
          status: report.status,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          errorCode: report.status === 'failed' ? 'eval_report_failed' : null,
          errorMessage: report.status === 'failed'
            ? 'Eval target or evaluator failed.'
            : null,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(and(
          eq(evalRuns.id, run.id),
          eq(evalRuns.status, 'running'),
          eq(evalRuns.leaseToken, input.leaseToken),
        ))
        .returning()
      if (!finished) throw new Error('Queued Eval completion lost its owner')
      return { status: 'committed' as const, run: finished }
    })
  }

  async failClaim(
    identity: EvalRunLeaseIdentity,
    errorCode: string,
    errorMessage: string,
  ) {
    const [run] = await this.db
      .update(evalRuns)
      .set({
        status: 'failed',
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorCode: identifier(errorCode, 'errorCode'),
        errorMessage: boundedError(errorMessage),
        finishedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(
        eq(evalRuns.id, identity.evalRunId),
        eq(evalRuns.status, 'running'),
        eq(evalRuns.leaseToken, identity.leaseToken),
        gt(evalRuns.leaseExpiresAt, sql`clock_timestamp()`),
      ))
      .returning()
    return run ? { status: 'failed' as const, run } : { status: 'lease_lost' as const }
  }

  async recordTrial<TOutput>(input: RecordEvalTrialInput<TOutput>) {
    const recordFingerprint = trialFingerprint(input.trial)
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select({ id: evalRuns.id, suiteId: evalRuns.suiteId, status: evalRuns.status })
        .from(evalRuns)
        .where(eq(evalRuns.id, input.evalRunId))
        .for('update')
        .limit(1)
      if (!run) throw new Error('Eval run not found')
      if (run.status !== 'running') throw new Error('Eval run is already terminal')
      const [evalCase] = await tx
        .select({ id: evalCases.id })
        .from(evalCases)
        .where(and(
          eq(evalCases.suiteId, run.suiteId),
          eq(evalCases.caseKey, identifier(input.trial.caseKey, 'trial.caseKey')),
        ))
        .limit(1)
      if (!evalCase) throw new Error('Eval trial case does not belong to the run suite')
      const startedAt = validDate(input.trial.startedAt, 'trial.startedAt')
      const finishedAt = validDate(input.trial.finishedAt, 'trial.finishedAt')
      if (finishedAt < startedAt) throw new Error('trial.finishedAt cannot precede startedAt')
      if (input.trial.output !== undefined) {
        assertJsonSize(input.trial.output, 'trial.output', MAX_CAPTURED_OUTPUT_BYTES)
      }

      const [created] = await tx
        .insert(evalTrials)
        .values({
          evalRunId: run.id,
          caseId: evalCase.id,
          trialIndex: input.trial.trialIndex,
          status: input.trial.status,
          sourceRunId: input.sourceRunId ?? null,
          output: input.trial.output ?? null,
          outputFingerprint: input.trial.outputFingerprint ?? null,
          recordFingerprint,
          errorCode: boundedError(input.trial.errorCode),
          errorMessage: input.trial.status === 'error' ? 'Eval target execution failed.' : null,
          startedAt,
          finishedAt,
        })
        .onConflictDoNothing()
        .returning()

      if (!created) {
        const [existing] = await tx
          .select()
          .from(evalTrials)
          .where(and(
            eq(evalTrials.evalRunId, run.id),
            eq(evalTrials.caseId, evalCase.id),
            eq(evalTrials.trialIndex, input.trial.trialIndex),
          ))
          .limit(1)
        if (!existing || existing.recordFingerprint !== recordFingerprint) {
          throw new Error(`Eval trial collision: ${input.trial.caseKey}:${input.trial.trialIndex}`)
        }
        return { trial: existing, recorded: false }
      }

      if (input.trial.scores.length > 0) {
        await tx.insert(evalScores).values(
          input.trial.scores.map((score) => scoreValues(created.id, score)),
        )
      }
      return { trial: created, recorded: true }
    })
  }

  async finishRun(evalRunId: string) {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(evalRuns)
        .where(eq(evalRuns.id, evalRunId))
        .for('update')
        .limit(1)
      if (!run) throw new Error('Eval run not found')
      if (run.status !== 'running') return run
      const [caseCount] = await tx
        .select({ value: count() })
        .from(evalCases)
        .where(eq(evalCases.suiteId, run.suiteId))
      const [trialCount] = await tx
        .select({ value: count() })
        .from(evalTrials)
        .where(eq(evalTrials.evalRunId, run.id))
      const expectedTrials = Number(caseCount?.value ?? 0) * run.trialsPerCase
      if (Number(trialCount?.value ?? 0) !== expectedTrials) {
        throw new Error(`Eval run is incomplete: expected ${expectedTrials} trials`)
      }
      const [trialErrors] = await tx
        .select({ value: count() })
        .from(evalTrials)
        .where(and(eq(evalTrials.evalRunId, run.id), eq(evalTrials.status, 'error')))
      const trialIds = (await tx
        .select({ id: evalTrials.id })
        .from(evalTrials)
        .where(eq(evalTrials.evalRunId, run.id))).map((trial) => trial.id)
      const [scoreErrors] = trialIds.length
        ? await tx
            .select({ value: count() })
            .from(evalScores)
            .where(and(
              inArray(evalScores.trialId, trialIds),
              eq(evalScores.status, 'error'),
            ))
        : [{ value: 0 }]
      const failed = Number(trialErrors?.value ?? 0) > 0 || Number(scoreErrors?.value ?? 0) > 0
      const [finished] = await tx
        .update(evalRuns)
        .set({
          status: failed ? 'failed' : 'completed',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(evalRuns.id, run.id), eq(evalRuns.status, 'running')))
        .returning()
      if (!finished) throw new Error('Eval run completion lost its owner')
      return finished
    })
  }

  async persistOfflineReport<TOutput>(
    namespaceKey: string,
    trigger: EvalRunTrigger,
    report: EvalRunReport<TOutput>,
  ) {
    const run = await this.startRun({
      namespaceKey,
      suiteKey: report.suite.key,
      suiteVersion: report.suite.version,
      datasetFingerprint: report.suite.datasetFingerprint,
      trigger,
      targetKey: report.target.key,
      targetVersion: report.target.version,
      execution: report.target.execution,
      trialsPerCase: report.trialsPerCase,
    })
    for (const trial of report.trials) {
      await this.recordTrial({ evalRunId: run.id, trial })
    }
    return this.finishRun(run.id)
  }
}

export function createEvalRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new EvalRepository(db)
}
