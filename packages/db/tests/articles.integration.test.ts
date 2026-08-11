import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { count } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createArticleRepository } from '../src/repositories/articles'
import { createJobRepository, type RunExecutionSnapshot } from '../src/repositories/jobs'
import { createTerminalRepository } from '../src/repositories/terminals'
import * as schema from '../src/schema'
import { SYSTEM_PRINCIPAL_ID, SYSTEM_WORKSPACE_ID } from '../src/domain'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
let client: PGlite
let db: PgliteDatabase<typeof schema>

const execution = {
  modelProfile: { profile: 'article-test', provider: 'scripted', model: 'scripted-v1' },
  promptVersion: 'prompt-v1',
  graphVersion: 'writer-graph-v1-target-2026-08-07',
  toolVersions: { writer: 'writer-v1' },
  codeRevision: 'article-test-revision',
} satisfies RunExecutionSnapshot

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

async function completedArticle(topic = 'Durable article') {
  const jobs = createJobRepository(db)
  const { job } = await jobs.createJob({
    workspaceId: SYSTEM_WORKSPACE_ID,
    createdByPrincipalId: SYSTEM_PRINCIPAL_ID,
    idempotencyKey: randomUUID(),
    topic,
    intervention: { on_outline: false },
  })
  const claim = await jobs.claimJob({
    jobId: job.id,
    workerId: 'worker-article',
    leaseDurationMs: 30_000,
    execution,
  })
  if (!claim) throw new Error('Expected claim')
  const result = await createTerminalRepository(db).completeClaim({
    jobId: job.id,
    runId: claim.run.id,
    leaseToken: claim.leaseToken,
    exportIdempotencyKey: `job:${job.id}:article:export`,
    topic,
    markdown: '# Original\n\n原始正文',
    outputPath: null,
  })
  if (!('article' in result)) throw new Error('Expected article')
  return result.article
}

describe('durable article repository', () => {
  it('lists and reads the terminal article projection', async () => {
    const first = await completedArticle('First')
    await completedArticle('Second')
    const repository = createArticleRepository(db)

    expect((await repository.listArticles()).map((article) => article.topic)).toEqual([
      'Second',
      'First',
    ])
    await expect(repository.getArticle(first.id)).resolves.toMatchObject({
      id: first.id,
      revision: 0,
      content: '# Original\n\n原始正文',
    })
    await expect(repository.getArticle(randomUUID())).resolves.toBeNull()
  })

  it('snapshots the previous revision on patch and the pre-restore current draft', async () => {
    const original = await completedArticle()
    const repository = createArticleRepository(db)

    const patched = await repository.patchArticle({
      articleId: original.id,
      content: '# Edited\n\n编辑后的正文',
      expectedRevision: 0,
    })
    expect(patched).toMatchObject({
      status: 'updated',
      article: { revision: 1, content: '# Edited\n\n编辑后的正文' },
      snapshot: { sourceRevision: 0, content: '# Original\n\n原始正文' },
    })
    if (patched.status !== 'updated') throw new Error('Expected updated article')

    await expect(
      repository.restoreVersion({
        articleId: original.id,
        versionId: patched.snapshot.id,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      article: { revision: 2, content: '# Original\n\n原始正文' },
      snapshot: { sourceRevision: 1, content: '# Edited\n\n编辑后的正文' },
    })
    expect((await repository.listVersions(original.id))?.map((row) => row.sourceRevision)).toEqual([
      1,
      0,
    ])
  })

  it('rejects stale writers and missing versions without creating a snapshot', async () => {
    const original = await completedArticle()
    const repository = createArticleRepository(db)
    const inputs = ['# Winner A', '# Winner B'].map((content) =>
      repository.patchArticle({
        articleId: original.id,
        content,
        expectedRevision: 0,
      }),
    )
    const results = await Promise.all(inputs)

    expect(results.map((result) => result.status).sort()).toEqual([
      'revision_conflict',
      'updated',
    ])
    const current = await repository.getArticle(original.id)
    expect(current?.revision).toBe(1)
    await expect(
      repository.restoreVersion({
        articleId: original.id,
        versionId: 999_999,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ status: 'version_not_found' })
    const [versionCount] = await db.select({ value: count() }).from(schema.articleVersions)
    expect(versionCount?.value).toBe(1)
  })
})
