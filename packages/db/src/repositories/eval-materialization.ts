import {
  fingerprintEvalDataset,
  fingerprintEvalValue,
  type EvalCase,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  articles,
  evalCandidateEvents,
  evalCandidates,
  evalCases,
  evalSuites,
} from '../schema'
import type { VibeDatabase } from './jobs'
import {
  requireWorkspaceOwner,
  setWorkspaceSession,
  type AuthorizedWorkspaceScope,
} from './workspaces'

const CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/
const MAX_CASE_JSON_BYTES = 1_048_576
const MAX_BATCH_SIZE = 100

function code(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !CODE_PATTERN.test(normalized)) {
    throw new Error(`${name} must be a lowercase machine-readable code`)
  }
  return normalized
}

function displayName(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512) {
    throw new Error('name must contain 1-512 non-whitespace characters')
  }
  return normalized
}

function databaseDate(value: Date | string, name: string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is not a valid database timestamp`)
  return date
}

function assertCaseSize(value: unknown, candidateId: string): void {
  fingerprintEvalValue(value)
  const serialized = JSON.stringify(value)
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > MAX_CASE_JSON_BYTES
  ) {
    throw new Error(
      `Materialized Eval case for candidate ${candidateId} exceeds ${MAX_CASE_JSON_BYTES} bytes`,
    )
  }
}

export type MaterializeApprovedCandidatesInput = {
  candidateIds: readonly string[]
  suiteKey: string
  suiteVersion: string
  name: string
  description?: string
  materializerKey: string
  materializerVersion: string
}

type MaterializedArticleInput = {
  schemaVersion: 1
  source: {
    candidateId: string
    articleRevision: number
    contentFingerprint: string
  }
  article: {
    markdown: string
  }
}

type MaterializedCase = EvalCase<MaterializedArticleInput, EvalJsonValue>

export class EvalMaterializationRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async materializeApprovedCandidates(
    scope: AuthorizedWorkspaceScope,
    input: MaterializeApprovedCandidatesInput,
  ) {
    requireWorkspaceOwner(scope)
    const candidateIds = [...new Set(input.candidateIds)].sort()
    if (candidateIds.length === 0 || candidateIds.length > MAX_BATCH_SIZE) {
      throw new Error(`candidateIds must contain 1-${MAX_BATCH_SIZE} unique ids`)
    }
    if (candidateIds.length !== input.candidateIds.length) {
      throw new Error('candidateIds cannot contain duplicates')
    }
    const namespaceKey = `workspace:${scope.workspaceId}`
    const suiteKey = code(input.suiteKey, 'suiteKey')
    const suiteVersion = code(input.suiteVersion, 'suiteVersion')
    const name = displayName(input.name)
    const description = input.description?.slice(0, 4_000) ?? ''
    const materializerKey = code(input.materializerKey, 'materializerKey')
    const materializerVersion = code(input.materializerVersion, 'materializerVersion')
    const materializerIdentity = `${materializerKey}:${materializerVersion}`
    if (materializerIdentity.length > 256) {
      throw new Error('materializerKey and materializerVersion identity exceeds 256 characters')
    }

    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const candidates = await scoped
        .select({
          row: evalCandidates,
          databaseNow: sql<Date>`clock_timestamp()`,
        })
        .from(evalCandidates)
        .where(and(
          eq(evalCandidates.workspaceId, scope.workspaceId),
          inArray(evalCandidates.id, candidateIds),
        ))
        .orderBy(evalCandidates.id)
        .for('update')
      if (candidates.length !== candidateIds.length) {
        throw new Error('One or more Eval candidates were not found in workspace')
      }
      const statuses = new Set(candidates.map((candidate) => candidate.row.status))
      if (statuses.size === 1 && statuses.has('materialized')) {
        const cases = await scoped
          .select()
          .from(evalCases)
          .where(inArray(evalCases.sourceCandidateId, candidateIds))
          .orderBy(evalCases.caseKey)
        if (
          cases.length !== candidateIds.length ||
          cases.some(
            (evalCase) =>
              evalCase.materializerKey !== materializerKey ||
              evalCase.materializerVersion !== materializerVersion,
          )
        ) {
          throw new Error('Materialized Eval candidate replay collision')
        }
        const suiteIds = new Set(cases.map((evalCase) => evalCase.suiteId))
        if (suiteIds.size !== 1) throw new Error('Materialized candidates belong to different suites')
        const [suite] = await scoped
          .select()
          .from(evalSuites)
          .where(eq(evalSuites.id, cases[0]!.suiteId))
          .limit(1)
        if (
          !suite || suite.workspaceId !== scope.workspaceId ||
          suite.namespaceKey !== namespaceKey || suite.suiteKey !== suiteKey ||
          suite.version !== suiteVersion || suite.name !== name ||
          suite.description !== description
        ) {
          throw new Error('Materialized Eval suite replay collision')
        }
        return { suite, cases, created: false }
      }
      if (statuses.size !== 1 || !statuses.has('approved')) {
        throw new Error('All Eval candidates must be approved and unmaterialized')
      }

      const now = databaseDate(candidates[0]!.databaseNow as Date | string, 'databaseNow')
      if (candidates.some((candidate) => candidate.row.retentionUntil <= now)) {
        throw new Error('An approved Eval candidate has reached its retention deadline')
      }
      const sourceArticleIds = candidates.map((candidate) => candidate.row.sourceArticleId)
      const sourceArticles = await scoped
        .select()
        .from(articles)
        .where(inArray(articles.id, sourceArticleIds))
      const articlesById = new Map(sourceArticles.map((article) => [article.id, article]))
      const cases = candidates.map<MaterializedCase>(({ row: candidate }) => {
        const article = articlesById.get(candidate.sourceArticleId)
        if (
          !article || article.jobId !== candidate.jobId ||
          article.revision !== candidate.sourceRevision ||
          article.contentFingerprint !== candidate.contentFingerprint
        ) {
          throw new Error(`Eval candidate ${candidate.id} source article is stale or missing`)
        }
        const caseInput: MaterializedArticleInput = {
          schemaVersion: 1,
          source: {
            candidateId: candidate.id,
            articleRevision: candidate.sourceRevision,
            contentFingerprint: candidate.contentFingerprint,
          },
          article: { markdown: article.content },
        }
        assertCaseSize(caseInput, candidate.id)
        return {
          key: `article-${candidate.id}`,
          input: caseInput,
          tags: [
            'live-eval',
            'user-content',
          ].sort(),
        }
      })
      const datasetFingerprint = fingerprintEvalDataset(cases)
      const [suite] = await scoped
        .insert(evalSuites)
        .values({
          workspaceId: scope.workspaceId,
          namespaceKey,
          suiteKey,
          version: suiteVersion,
          name,
          description,
          status: 'draft',
          datasetFingerprint,
        })
        .onConflictDoNothing()
        .returning()
      if (!suite) {
        throw new Error(`Eval materialization suite version collision: ${suiteKey}@${suiteVersion}`)
      }
      const retentionByCandidate = new Map(
        candidates.map((candidate) => [candidate.row.id, candidate.row.retentionUntil]),
      )
      const insertedCases = await scoped
        .insert(evalCases)
        .values(cases.map((evalCase) => ({
          suiteId: suite.id,
          caseKey: evalCase.key,
          input: evalCase.input,
          expected: null,
          inputFingerprint: fingerprintEvalValue(evalCase.input),
          dataClassification: 'user_content' as const,
          sourceCandidateId: evalCase.input.source.candidateId,
          retentionUntil: retentionByCandidate.get(evalCase.input.source.candidateId)!,
          materializerKey,
          materializerVersion,
          tags: [...(evalCase.tags ?? [])],
        })))
        .returning()
      if (insertedCases.length !== candidates.length) {
        throw new Error('Eval materialization case insert was incomplete')
      }
      for (const candidate of candidates) {
        const [updated] = await scoped
          .update(evalCandidates)
          .set({
            status: 'materialized',
            nextEventSeq: candidate.row.nextEventSeq + 1,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(
            eq(evalCandidates.id, candidate.row.id),
            eq(evalCandidates.status, 'approved'),
          ))
          .returning()
        if (!updated) throw new Error('Eval materialization lost its candidate row lock')
        await scoped.insert(evalCandidateEvents).values({
          candidateId: updated.id,
          seq: candidate.row.nextEventSeq,
          eventType: 'materialized',
          actorPrincipalId: scope.principalId,
          reasonCode: materializerIdentity,
        })
      }
      return { suite, cases: insertedCases, created: true }
    })
  }

  async activateMaterializedSuite(
    scope: AuthorizedWorkspaceScope,
    suiteId: string,
  ) {
    requireWorkspaceOwner(scope)
    return this.db.transaction(async (tx) => {
      const scoped = tx as unknown as VibeDatabase<TQueryResult>
      await setWorkspaceSession(scoped, scope)
      const [suite] = await scoped
        .select()
        .from(evalSuites)
        .where(and(
          eq(evalSuites.id, suiteId),
          eq(evalSuites.workspaceId, scope.workspaceId),
        ))
        .for('update')
        .limit(1)
      if (!suite) throw new Error('Materialized Eval suite not found in workspace')
      if (suite.status === 'archived') throw new Error('Archived Eval suite cannot be activated')
      const cases = await scoped
        .select()
        .from(evalCases)
        .where(eq(evalCases.suiteId, suite.id))
      if (
        cases.length === 0 ||
        cases.some(
          (evalCase) =>
            evalCase.dataClassification !== 'user_content' ||
            !evalCase.sourceCandidateId || !evalCase.retentionUntil ||
            !evalCase.materializerKey || !evalCase.materializerVersion ||
            fingerprintEvalValue(evalCase.input) !== evalCase.inputFingerprint,
        )
      ) {
        throw new Error('Materialized Eval suite cases are incomplete or invalid')
      }
      const normalized = cases.map<MaterializedCase>((evalCase) => ({
        key: evalCase.caseKey,
        input: evalCase.input as MaterializedArticleInput,
        ...(evalCase.expected === null
          ? {}
          : { expected: evalCase.expected as EvalJsonValue }),
        tags: evalCase.tags,
      }))
      if (fingerprintEvalDataset(normalized) !== suite.datasetFingerprint) {
        throw new Error('Materialized Eval suite fingerprint no longer matches its cases')
      }
      const candidateIds = cases.map((evalCase) => evalCase.sourceCandidateId!)
      const validCandidates = await scoped
        .select({ id: evalCandidates.id })
        .from(evalCandidates)
        .where(and(
          eq(evalCandidates.workspaceId, scope.workspaceId),
          eq(evalCandidates.status, 'materialized'),
          inArray(evalCandidates.id, candidateIds),
          sql`${evalCandidates.retentionUntil} > clock_timestamp()`,
        ))
      const [expiredCaseCount] = await scoped
        .select({ count: sql<number>`count(*)` })
        .from(evalCases)
        .where(and(
          eq(evalCases.suiteId, suite.id),
          sql`${evalCases.retentionUntil} <= clock_timestamp()`,
        ))
      if (validCandidates.length !== candidateIds.length || Number(expiredCaseCount?.count) !== 0) {
        throw new Error('Materialized Eval suite governance is no longer valid')
      }
      if (suite.status === 'active') {
        return { suite, changed: false }
      }
      const [active] = await scoped
        .update(evalSuites)
        .set({ status: 'active', updatedAt: sql`clock_timestamp()` })
        .where(and(eq(evalSuites.id, suite.id), eq(evalSuites.status, 'draft')))
        .returning()
      if (!active) throw new Error('Materialized Eval suite activation lost its row lock')
      return { suite: active, changed: true }
    })
  }
}

export function createEvalMaterializationRepository<
  TQueryResult extends PgQueryResultHKT,
>(db: VibeDatabase<TQueryResult>) {
  return new EvalMaterializationRepository(db)
}
