import { randomUUID } from 'node:crypto'
import {
  assertCurrentEvalRuntimeRole,
  createEvalSamplingRepository,
  createJobRepository,
  createPostgresDatabase,
  createTerminalRepository,
  createWorkspaceRepository,
  evalCandidates,
  evalSamplingPolicies,
  provisionEvalRuntimeRole,
} from '@vibe-writer/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createLiveEvalSamplerRuntime } from '../src/live-sampler-runtime.ts'

const connectionString = process.env.TEST_DATABASE_URL
const destructiveTestId = process.env.VIBE_WRITER_POSTGRES_TEST_ID
if (!connectionString || !destructiveTestId || !/^[0-9a-f]{32}$/.test(destructiveTestId)) {
  throw new Error('Harness-created PostgreSQL target is required')
}

const expectedDatabaseName = `vibe_writer_integration_${destructiveTestId}`
const expectedDatabaseComment = `vibe-writer-ephemeral:${destructiveTestId}`
const ownerDatabase = createPostgresDatabase(connectionString, { max: 1 })
const samplerRole = `eval_sampler_${destructiveTestId}`
const samplerUrl = new URL(connectionString)
samplerUrl.username = samplerRole
samplerUrl.password = ''
const samplerDatabase = createPostgresDatabase(samplerUrl.toString(), { max: 1 })

afterAll(async () => {
  await Promise.allSettled([samplerDatabase.close(), ownerDatabase.close()])
})

describe('live Eval sampler PostgreSQL process composition', () => {
  it('starts an independent loop and materializes a governed pointer on its first tick', async () => {
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
    expect(target).toEqual({
      database: expectedDatabaseName,
      address: '127.0.0.1',
      comment: expectedDatabaseComment,
    })

    await ownerDatabase.client.unsafe(`CREATE ROLE \"${samplerRole}\"`)
    await provisionEvalRuntimeRole(ownerDatabase.client, 'live-sampler', samplerRole)
    await expect(assertCurrentEvalRuntimeRole(
      samplerDatabase.client,
      'live-sampler',
      samplerRole,
    )).resolves.toMatchObject({ issues: [] })

    const scope = await createWorkspaceRepository(ownerDatabase.db).provision({
      principalId: randomUUID(),
      workspaceId: randomUUID(),
      slug: `live-sampler-${randomUUID().slice(0, 8)}`,
      name: 'Live sampler process test',
    })
    const sampling = createEvalSamplingRepository(ownerDatabase.db)
    const configured = await sampling.configurePolicy(scope, {
      samplerKey: 'completed-production-run',
      samplerVersion: 'v1',
      sampleRateBps: 10_000,
      consentPolicyVersion: 'workspace-eval-consent-v1',
      retentionDays: 30,
    })
    const jobs = createJobRepository(ownerDatabase.db)
    const { job } = await jobs.createJob({
      workspaceId: scope.workspaceId,
      createdByPrincipalId: scope.principalId,
      idempotencyKey: `live-sampler-source-${randomUUID()}`,
      topic: 'Private live sampler source',
      intervention: { on_outline: false },
    })
    const claim = await jobs.claimJob({
      jobId: job.id,
      workerId: 'live-sampler-source-worker',
      leaseDurationMs: 30_000,
      execution: {
        modelProfile: { profile: 'sampler-test', provider: 'scripted', model: 'scripted-v1' },
        promptVersion: 'prompt-v1',
        graphVersion: 'writer-graph-v1-target-2026-08-07',
        toolVersions: { writer: 'writer-tools-v1' },
        codeRevision: 'sampler-process-test',
      },
    })
    if (!claim) throw new Error('Expected live sampler source claim')
    const terminal = await createTerminalRepository(ownerDatabase.db).completeClaim({
      jobId: job.id,
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
      exportIdempotencyKey: `job:${job.id}:article:export`,
      topic: 'Private live sampler source',
      markdown: '# Private live sampler source\n\nThis body must stay outside Eval candidates.',
      outputPath: null,
    })
    if (!('article' in terminal)) throw new Error('Expected live sampler source article')

    const runtime = createLiveEvalSamplerRuntime({
      database: { url: samplerUrl.toString(), role: samplerRole },
      pollIntervalMs: 50,
      policyLimit: 10,
      sourceBatchSize: 10,
    })
    try {
      await runtime.start()
    } finally {
      await runtime.close()
    }

    const [candidate] = await ownerDatabase.db
      .select()
      .from(evalCandidates)
      .where(and(
        eq(evalCandidates.workspaceId, scope.workspaceId),
        eq(evalCandidates.sourceRunId, claim.run.id),
      ))
    expect(candidate).toMatchObject({
      samplingPolicyId: configured.policy.id,
      sourceArticleId: terminal.article.id,
      sourceRevision: terminal.article.revision,
      contentFingerprint: terminal.article.contentFingerprint,
      consentBasis: 'workspace_policy',
    })
    expect(JSON.stringify(candidate)).not.toContain('Private live sampler source')
    expect(JSON.stringify(candidate)).not.toContain('This body must stay outside')
    const [policy] = await ownerDatabase.db
      .select()
      .from(evalSamplingPolicies)
      .where(eq(evalSamplingPolicies.id, configured.policy.id))
    expect(policy).toMatchObject({ cursorRunId: claim.run.id })
    expect(policy?.lastScannedAt).not.toBeNull()

    await expect(samplerDatabase.client`
      SELECT id, content_fingerprint FROM articles LIMIT 1
    `).resolves.toHaveLength(1)
    await expect(samplerDatabase.client`
      SELECT content FROM articles LIMIT 1
    `).rejects.toThrow()
    await expect(samplerDatabase.client`
      SELECT topic FROM jobs LIMIT 1
    `).rejects.toThrow()
    await expect(samplerDatabase.client`
      CREATE SCHEMA eval_sampler_forbidden
    `).rejects.toThrow()
  })
})
