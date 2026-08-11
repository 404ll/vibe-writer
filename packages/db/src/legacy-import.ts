import { createHash } from 'node:crypto'
import { and, asc, eq, or } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  articles,
  articleVersions,
  jobEvents,
  jobs,
  runs,
} from './schema'
import type { VibeDatabase } from './repositories/jobs'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from './domain'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const IMPORT_VERSION = 'legacy-sqlite-import-v1'

export type LegacySqliteVersion = {
  legacyId: number
  content: string
  wordCount: number
  savedAt: string
}

export type LegacySqliteArticle = {
  id: string
  jobId: string
  topic: string
  content: string
  wordCount: number
  createdAt: string
  versions: LegacySqliteVersion[]
}

export type LegacySqliteManifest = {
  schemaVersion: 1
  sourceSha256: string
  articles: LegacySqliteArticle[]
}

export type LegacyArticleImportReport = {
  mode: 'dry-run' | 'apply'
  sourceSha256: string
  articleCount: number
  versionCount: number
  wouldImport: number
  imported: number
  replayed: number
}

type NormalizedVersion = Omit<LegacySqliteVersion, 'savedAt'> & { savedAt: Date }
type NormalizedArticle = Omit<LegacySqliteArticle, 'createdAt' | 'versions'> & {
  createdAt: Date
  updatedAt: Date
  versions: NormalizedVersion[]
}

export class LegacyArticleImportError extends Error {
  readonly name = 'LegacyArticleImportError'
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) throw new LegacyArticleImportError(`${field} is required`)
  return value
}

function timestamp(value: string, field: string): Date {
  const normalized = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value) ? value : `${value}Z`
  const date = new Date(normalized)
  if (!Number.isFinite(date.getTime())) {
    throw new LegacyArticleImportError(`${field} must be an ISO timestamp`)
  }
  return date
}

function nonnegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new LegacyArticleImportError(`${field} must be a non-negative integer`)
  }
  return value
}

function contentFingerprint(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function doneFingerprint(articleId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ article_id: articleId, output_path: null }))
    .digest('hex')
}

export function legacyRunId(jobId: string): string {
  const bytes = createHash('sha256')
    .update(`vibe-writer:${IMPORT_VERSION}:run:${jobId}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function normalizeManifest(manifest: LegacySqliteManifest): NormalizedArticle[] {
  if (manifest.schemaVersion !== 1) {
    throw new LegacyArticleImportError('Unsupported legacy manifest schema version')
  }
  if (!SHA256_PATTERN.test(manifest.sourceSha256)) {
    throw new LegacyArticleImportError('sourceSha256 must be a canonical SHA-256 fingerprint')
  }
  const articleIds = new Set<string>()
  const jobIds = new Set<string>()
  return manifest.articles.map((article, articleIndex) => {
    const prefix = `articles[${articleIndex}]`
    if (!UUID_PATTERN.test(article.id)) {
      throw new LegacyArticleImportError(`${prefix}.id must be a UUID`)
    }
    if (!UUID_PATTERN.test(article.jobId)) {
      throw new LegacyArticleImportError(`${prefix}.jobId must be a UUID`)
    }
    if (articleIds.has(article.id)) {
      throw new LegacyArticleImportError(`Duplicate legacy article id ${article.id}`)
    }
    if (jobIds.has(article.jobId)) {
      throw new LegacyArticleImportError(`Duplicate legacy job id ${article.jobId}`)
    }
    articleIds.add(article.id)
    jobIds.add(article.jobId)
    const createdAt = timestamp(article.createdAt, `${prefix}.createdAt`)
    const legacyVersionIds = new Set<number>()
    const versions = article.versions
      .map((version, versionIndex) => {
        const versionPrefix = `${prefix}.versions[${versionIndex}]`
        const legacyId = nonnegativeInt(version.legacyId, `${versionPrefix}.legacyId`)
        if (legacyVersionIds.has(legacyId)) {
          throw new LegacyArticleImportError(`Duplicate legacy version id ${legacyId}`)
        }
        legacyVersionIds.add(legacyId)
        return {
          legacyId,
          content: requiredText(version.content, `${versionPrefix}.content`),
          wordCount: nonnegativeInt(version.wordCount, `${versionPrefix}.wordCount`),
          savedAt: timestamp(version.savedAt, `${versionPrefix}.savedAt`),
        }
      })
      .sort((left, right) =>
        left.savedAt.getTime() - right.savedAt.getTime() ||
        left.legacyId - right.legacyId,
      )
    const updatedAt = versions.at(-1)?.savedAt ?? createdAt
    return {
      id: article.id,
      jobId: article.jobId,
      topic: requiredText(article.topic, `${prefix}.topic`),
      content: requiredText(article.content, `${prefix}.content`),
      wordCount: nonnegativeInt(article.wordCount, `${prefix}.wordCount`),
      createdAt,
      updatedAt: updatedAt > createdAt ? updatedAt : createdAt,
      versions,
    }
  })
}

function sameTime(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime()
}

async function verifyReplay<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
  article: NormalizedArticle,
  sourceSha256: string,
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(articles)
    .where(or(eq(articles.id, article.id), eq(articles.jobId, article.jobId)))
    .limit(1)
  if (!existing) return false
  const runId = legacyRunId(article.jobId)
  const codeRevision = `${IMPORT_VERSION}@${sourceSha256}`
  const [job] = await db.select().from(jobs).where(eq(jobs.id, article.jobId)).limit(1)
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.jobId, article.jobId)))
    .limit(1)
  const versions = await db
    .select()
    .from(articleVersions)
    .where(eq(articleVersions.articleId, article.id))
    .orderBy(asc(articleVersions.sourceRevision))

  const exact =
    existing.id === article.id &&
    existing.jobId === article.jobId &&
    existing.sourceRunId === runId &&
    existing.topic === article.topic &&
    existing.contentFingerprint === contentFingerprint(article.content) &&
    existing.wordCount === article.wordCount &&
    existing.revision === article.versions.length &&
    sameTime(existing.createdAt, article.createdAt) &&
    job?.status === 'completed' &&
    run?.status === 'completed' &&
    run.codeRevision === codeRevision &&
    versions.length === article.versions.length &&
    versions.every((version, index) => {
      const source = article.versions[index]!
      return version.sourceRevision === index &&
        version.contentFingerprint === contentFingerprint(source.content) &&
        version.wordCount === source.wordCount &&
        sameTime(version.savedAt, source.savedAt)
    })
  if (!exact) {
    throw new LegacyArticleImportError(
      `Legacy import collision for article ${article.id} or job ${article.jobId}`,
    )
  }
  return true
}

async function ensureNoIdentityCollision<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
  article: NormalizedArticle,
): Promise<void> {
  const runId = legacyRunId(article.jobId)
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, article.jobId)).limit(1)
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).limit(1)
  if (job || run) {
    throw new LegacyArticleImportError(
      `Legacy identity collision for article ${article.id} or job ${article.jobId}`,
    )
  }
}

async function insertArticle<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
  article: NormalizedArticle,
  sourceSha256: string,
): Promise<void> {
  const runId = legacyRunId(article.jobId)
  const codeRevision = `${IMPORT_VERSION}@${sourceSha256}`
  await db.insert(jobs).values({
    id: article.jobId,
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: `legacy-sqlite:job:${article.jobId}`,
    topic: article.topic,
    style: '',
    intervention: { on_outline: false },
    status: 'completed',
    stage: 'export',
    nextEventSeq: 1,
    version: 1,
    startedAt: article.createdAt,
    finishedAt: article.createdAt,
    createdAt: article.createdAt,
    updatedAt: article.createdAt,
  })
  await db.insert(runs).values({
    id: runId,
    jobId: article.jobId,
    attempt: 1,
    status: 'completed',
    modelProfile: {
      profile: 'legacy-sqlite-import',
      provider: 'legacy-python',
      model: 'unknown',
    },
    promptVersion: 'legacy-python-prompt-unknown',
    graphVersion: 'legacy-python-graph-unknown',
    toolVersions: { writer: 'legacy-python-tools-unknown' },
    codeRevision,
    startedAt: article.createdAt,
    finishedAt: article.createdAt,
    createdAt: article.createdAt,
    updatedAt: article.createdAt,
  })
  await db.insert(articles).values({
    id: article.id,
    jobId: article.jobId,
    sourceRunId: runId,
    exportIdempotencyKey: `legacy-sqlite:article:${article.id}`,
    topic: article.topic,
    content: article.content,
    contentFingerprint: contentFingerprint(article.content),
    wordCount: article.wordCount,
    revision: article.versions.length,
    graphVersion: 'legacy-python-graph-unknown',
    promptVersion: 'legacy-python-prompt-unknown',
    codeRevision,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  })
  if (article.versions.length > 0) {
    await db.insert(articleVersions).values(article.versions.map((version, index) => ({
      articleId: article.id,
      sourceRevision: index,
      content: version.content,
      contentFingerprint: contentFingerprint(version.content),
      wordCount: version.wordCount,
      savedAt: version.savedAt,
    })))
  }
  await db.insert(jobEvents).values({
    jobId: article.jobId,
    seq: 0,
    runId,
    idempotencyKey: `job:${article.jobId}:terminal:done:v1`,
    payloadFingerprint: doneFingerprint(article.id),
    eventType: 'done',
    eventData: { output_path: null, article_id: article.id },
    createdAt: article.createdAt,
  })
}

export async function importLegacySqliteArticles<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
  manifest: LegacySqliteManifest,
  options: { apply?: boolean } = {},
): Promise<LegacyArticleImportReport> {
  const normalized = normalizeManifest(manifest)
  return db.transaction(async (tx) => {
    let wouldImport = 0
    let imported = 0
    let replayed = 0
    for (const article of normalized) {
      if (await verifyReplay(tx, article, manifest.sourceSha256)) {
        replayed += 1
        continue
      }
      await ensureNoIdentityCollision(tx, article)
      wouldImport += 1
      if (options.apply) {
        await insertArticle(tx, article, manifest.sourceSha256)
        imported += 1
      }
    }
    return {
      mode: options.apply ? 'apply' : 'dry-run',
      sourceSha256: manifest.sourceSha256,
      articleCount: normalized.length,
      versionCount: normalized.reduce((total, article) => total + article.versions.length, 0),
      wouldImport,
      imported,
      replayed,
    }
  })
}
