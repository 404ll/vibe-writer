import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { asc, count, eq } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  importLegacySqliteArticles,
  legacyRunId,
  type LegacySqliteManifest,
} from '../src/legacy-import'
import { readLegacySqliteManifest } from '../src/legacy-sqlite'
import * as schema from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const articleId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const sourceSha256 = `sha256:${'a'.repeat(64)}`
let client: PGlite
let db: PgliteDatabase<typeof schema>

function manifest(): LegacySqliteManifest {
  return {
    schemaVersion: 1,
    sourceSha256,
    articles: [{
      id: articleId,
      jobId,
      topic: 'Legacy article',
      content: '# Current',
      wordCount: 8,
      createdAt: '2026-04-01 08:00:00.000000',
      versions: [
        {
          legacyId: 9,
          content: '# Original',
          wordCount: 9,
          savedAt: '2026-04-02 08:00:00.000000',
        },
        {
          legacyId: 10,
          content: '# Edited',
          wordCount: 7,
          savedAt: '2026-04-03 08:00:00.000000',
        },
      ],
    }],
  }
}

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

beforeEach(async () => {
  await client.exec(
    'TRUNCATE TABLE article_versions, articles, job_commands, job_interrupts, checkpoint_attempts, run_effects, job_events, runs, outbox_events, jobs CASCADE;',
  )
})

afterAll(async () => {
  await client.close()
})

describe('legacy SQLite article migration', () => {
  it('reads the source in query-only mode and fingerprints the exact database file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vibe-writer-legacy-source-'))
    const path = join(directory, 'legacy.db')
    try {
      const sqlite = new DatabaseSync(path)
      sqlite.exec(`
        CREATE TABLE articles (
          id VARCHAR PRIMARY KEY, job_id VARCHAR UNIQUE NOT NULL, topic TEXT NOT NULL,
          content TEXT NOT NULL, word_count INTEGER NOT NULL, created_at DATETIME NOT NULL
        );
        CREATE TABLE article_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, article_id VARCHAR NOT NULL,
          content TEXT NOT NULL, word_count INTEGER NOT NULL, saved_at DATETIME NOT NULL
        );
      `)
      sqlite.prepare(
        'INSERT INTO articles VALUES (?, ?, ?, ?, ?, ?)',
      ).run(articleId, jobId, 'Legacy article', '# Current', 8, '2026-04-01 08:00:00.000000')
      sqlite.prepare(
        'INSERT INTO article_versions (article_id, content, word_count, saved_at) VALUES (?, ?, ?, ?)',
      ).run(articleId, '# Original', 9, '2026-04-02 08:00:00.000000')
      sqlite.close()

      const result = await readLegacySqliteManifest(path)
      expect(result.sourceSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(result.articles).toEqual([expect.objectContaining({
        id: articleId,
        jobId,
        versions: [expect.objectContaining({ legacyId: 1, content: '# Original' })],
      })])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('dry-runs without writes, then imports deterministic provenance and ordered revisions', async () => {
    await expect(importLegacySqliteArticles(db, manifest())).resolves.toMatchObject({
      mode: 'dry-run',
      articleCount: 1,
      versionCount: 2,
      wouldImport: 1,
      imported: 0,
    })
    const [before] = await db.select({ value: count() }).from(schema.articles)
    expect(before?.value).toBe(0)

    await expect(importLegacySqliteArticles(db, manifest(), { apply: true }))
      .resolves.toMatchObject({ mode: 'apply', imported: 1, replayed: 0 })
    const [article] = await db.select().from(schema.articles)
    expect(article).toMatchObject({
      id: articleId,
      jobId,
      sourceRunId: legacyRunId(jobId),
      revision: 2,
      content: '# Current',
      codeRevision: `${'legacy-sqlite-import-v1'}@${sourceSha256}`,
    })
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId))
    expect(job).toMatchObject({ status: 'completed', stage: 'export', nextEventSeq: 1 })
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.jobId, jobId))
    expect(run).toMatchObject({
      id: legacyRunId(jobId),
      status: 'completed',
      modelProfile: { profile: 'legacy-sqlite-import', provider: 'legacy-python', model: 'unknown' },
    })
    const versions = await db
      .select()
      .from(schema.articleVersions)
      .where(eq(schema.articleVersions.articleId, articleId))
      .orderBy(asc(schema.articleVersions.sourceRevision))
    expect(versions.map((version) => ({
      sourceRevision: version.sourceRevision,
      content: version.content,
      savedAt: version.savedAt.toISOString(),
    }))).toEqual([
      { sourceRevision: 0, content: '# Original', savedAt: '2026-04-02T08:00:00.000Z' },
      { sourceRevision: 1, content: '# Edited', savedAt: '2026-04-03T08:00:00.000Z' },
    ])
    const [event] = await db.select().from(schema.jobEvents)
    expect(event).toMatchObject({ seq: 0, eventType: 'done', runId: legacyRunId(jobId) })
    const [outboxCount] = await db.select({ value: count() }).from(schema.outboxEvents)
    expect(outboxCount?.value).toBe(0)
  })

  it('replays an identical import and rejects content or provenance collisions', async () => {
    await importLegacySqliteArticles(db, manifest(), { apply: true })
    await expect(importLegacySqliteArticles(db, manifest(), { apply: true }))
      .resolves.toMatchObject({ imported: 0, replayed: 1, wouldImport: 0 })

    const changed = manifest()
    changed.articles[0]!.content = '# Different'
    await expect(importLegacySqliteArticles(db, changed, { apply: true }))
      .rejects.toThrow('collision')

    const differentSource = manifest()
    differentSource.sourceSha256 = `sha256:${'b'.repeat(64)}`
    await expect(importLegacySqliteArticles(db, differentSource, { apply: true }))
      .rejects.toThrow('collision')
  })

  it('rejects non-UUID legacy identities instead of silently changing bookmarks', async () => {
    const invalid = manifest()
    invalid.articles[0]!.id = 'legacy-id'
    await expect(importLegacySqliteArticles(db, invalid))
      .rejects.toThrow('must be a UUID')
  })
})
