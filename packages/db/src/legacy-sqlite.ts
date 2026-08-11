import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  LegacySqliteArticle,
  LegacySqliteManifest,
  LegacySqliteVersion,
} from './legacy-import'

type ArticleRecord = {
  id: string
  job_id: string
  topic: string
  content: string
  word_count: number
  created_at: string
}

type VersionRecord = {
  id: number
  article_id: string
  content: string
  word_count: number
  saved_at: string
}

async function fingerprint(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

function rejectActiveWal(path: string): void {
  const walPath = `${path}-wal`
  if (existsSync(walPath) && statSync(walPath).size > 0) {
    throw new Error('Legacy SQLite WAL is not empty; stop the Python writer and checkpoint it first')
  }
}

export async function readLegacySqliteManifest(sourcePath: string): Promise<LegacySqliteManifest> {
  const path = resolve(sourcePath)
  rejectActiveWal(path)
  const before = await fingerprint(path)
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    database.exec('PRAGMA query_only = ON')
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('articles', 'article_versions') ORDER BY name",
    ).all() as Array<{ name: string }>
    if (tables.map((table) => table.name).join(',') !== 'article_versions,articles') {
      throw new Error('Legacy SQLite source is missing articles or article_versions')
    }
    const articleRows = database.prepare(
      'SELECT id, job_id, topic, content, word_count, created_at FROM articles ORDER BY created_at, id',
    ).all() as ArticleRecord[]
    const versionRows = database.prepare(
      'SELECT id, article_id, content, word_count, saved_at FROM article_versions ORDER BY saved_at, id',
    ).all() as VersionRecord[]
    const versionsByArticle = new Map<string, LegacySqliteVersion[]>()
    for (const row of versionRows) {
      const versions = versionsByArticle.get(row.article_id) ?? []
      versions.push({
        legacyId: row.id,
        content: row.content,
        wordCount: row.word_count,
        savedAt: row.saved_at,
      })
      versionsByArticle.set(row.article_id, versions)
    }
    const articleIds = new Set(articleRows.map((row) => row.id))
    const orphan = [...versionsByArticle.keys()].find((articleId) => !articleIds.has(articleId))
    if (orphan) throw new Error(`Legacy SQLite contains orphan versions for article ${orphan}`)
    const articles: LegacySqliteArticle[] = articleRows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      topic: row.topic,
      content: row.content,
      wordCount: row.word_count,
      createdAt: row.created_at,
      versions: versionsByArticle.get(row.id) ?? [],
    }))
    database.close()
    rejectActiveWal(path)
    const after = await fingerprint(path)
    if (before !== after) throw new Error('Legacy SQLite source changed while it was being read')
    return { schemaVersion: 1, sourceSha256: after, articles }
  } finally {
    if (database.isOpen) database.close()
  }
}
