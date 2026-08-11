import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SYSTEM_PRINCIPAL_ID,
  SYSTEM_WORKSPACE_ID,
} from '../src/domain'
import { createWorkspaceScopedRepositories } from '../src/repositories/scoped'
import { createWorkspaceRepository } from '../src/repositories/workspaces'
import * as schema from '../src/schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const workspaceMigration = '20260807061613_nosy_swarm.sql'
let client: PGlite
let db: PgliteDatabase<typeof schema>

beforeAll(async () => {
  client = await PGlite.create()
  db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await client.close()
})

describe('workspace identity and application isolation', () => {
  it('backfills existing jobs into an explicit legacy ownership scope', async () => {
    const legacy = await PGlite.create()
    try {
      const migrations = readdirSync(migrationsFolder)
        .filter((file) => file.endsWith('.sql') && file < workspaceMigration)
        .sort()
      for (const migration of migrations) {
        await legacy.exec(readFileSync(`${migrationsFolder}/${migration}`, 'utf8'))
      }
      const jobId = randomUUID()
      await legacy.query(
        `INSERT INTO jobs (id, idempotency_key, topic)
         VALUES ($1, 'legacy-scope', 'Legacy scope')`,
        [jobId],
      )
      await legacy.exec(readFileSync(`${migrationsFolder}/${workspaceMigration}`, 'utf8'))
      const result = await legacy.query<{
        workspace_id: string
        created_by_principal_id: string
      }>(
        `SELECT workspace_id, created_by_principal_id FROM jobs WHERE id = $1`,
        [jobId],
      )
      expect(result.rows[0]).toEqual({
        workspace_id: SYSTEM_WORKSPACE_ID,
        created_by_principal_id: SYSTEM_PRINCIPAL_ID,
      })
    } finally {
      await legacy.close()
    }
  })

  it('authorizes active membership and scopes idempotency, reads, mutations and articles', async () => {
    const workspaces = createWorkspaceRepository(db)
    const first = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `first-${randomUUID().slice(0, 8)}`,
      name: 'First workspace',
      identity: { issuer: 'https://identity.example', subject: `first-${randomUUID()}` },
    })
    const second = await workspaces.provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `second-${randomUUID().slice(0, 8)}`,
      name: 'Second workspace',
      identity: { issuer: 'https://identity.example', subject: `second-${randomUUID()}` },
    })
    const firstRepositories = createWorkspaceScopedRepositories(db, first)
    const secondRepositories = createWorkspaceScopedRepositories(db, second)

    const sharedRequest = {
      idempotencyKey: 'same-browser-request',
      topic: 'Scoped writing',
      intervention: { on_outline: false },
    }
    const firstJob = (await firstRepositories.jobs.createJob(sharedRequest)).job
    const secondJob = (await secondRepositories.jobs.createJob(sharedRequest)).job
    expect(firstJob.id).not.toBe(secondJob.id)
    expect(firstJob.workspaceId).toBe(first.workspaceId)
    expect(secondJob.workspaceId).toBe(second.workspaceId)
    await expect(firstRepositories.jobs.getJob(secondJob.id)).resolves.toBeNull()
    await expect(firstRepositories.jobs.requestCancellation(secondJob.id))
      .resolves.toBe('not_found')
    await expect(firstRepositories.jobs.requestCancellation(firstJob.id))
      .resolves.toBe('cancelled')
    await expect(secondRepositories.jobs.listEventsAfter(firstJob.id))
      .resolves.toBeNull()

    const runId = randomUUID()
    await db.insert(schema.runs).values({
      id: runId,
      jobId: secondJob.id,
      attempt: 1,
      status: 'completed',
      modelProfile: { profile: 'scope-test', provider: 'scripted', model: 'v1' },
      promptVersion: 'prompt-v1',
      graphVersion: 'graph-v1',
      toolVersions: { writer: 'writer-v1' },
      codeRevision: 'scope-test',
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    await db.insert(schema.articles).values({
      jobId: secondJob.id,
      sourceRunId: runId,
      exportIdempotencyKey: `scope-article-${secondJob.id}`,
      topic: secondJob.topic,
      content: '# Private workspace article',
      contentFingerprint: `sha256:${'a'.repeat(64)}`,
      wordCount: 24,
      graphVersion: 'graph-v1',
      promptVersion: 'prompt-v1',
      codeRevision: 'scope-test',
    })
    await expect(firstRepositories.articles.listArticles()).resolves.toEqual([])
    await expect(secondRepositories.articles.listArticles()).resolves.toHaveLength(1)
  })

  it('does not authorize missing or inactive membership', async () => {
    const repository = createWorkspaceRepository(db)
    await expect(repository.authorize({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
    })).resolves.toBeNull()
  })

  it('lets viewers read but rejects workspace mutations at the repository boundary', async () => {
    const scope = await createWorkspaceRepository(db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `viewer-${randomUUID().slice(0, 8)}`,
      name: 'Viewer workspace',
      role: 'viewer',
    })
    const repositories = createWorkspaceScopedRepositories(db, scope)
    await expect(repositories.articles.listArticles()).resolves.toEqual([])
    expect(() => repositories.jobs.createJob({
      idempotencyKey: 'viewer-write',
      topic: 'Forbidden write',
      intervention: { on_outline: false },
    })).toThrow('Workspace editor permission is required')
  })
})
