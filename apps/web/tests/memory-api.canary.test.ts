import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  createServer as createHttpServer,
  request as requestHttp,
  type Server as HttpServer,
} from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  createMemoryRepository,
  createMemorySourceSignalRepository,
  createPostgresDatabase,
  createWorkspaceRepository,
  type AuthorizedWorkspaceScope,
} from '@vibe-writer/db'
import {
  assertCurrentDurableApiRole,
  durableApiRoleProvisioningStatements,
} from '@vibe-writer/db/durable-api-role'
import { migrateVibePostgresDatabase } from '@vibe-writer/db/migrations'
import { afterAll, describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Memory API canary requires ${name}`)
  return value
}

const ownerDatabaseUrl = requiredEnvironment('TEST_DATABASE_URL')
const apiDatabaseUrl = requiredEnvironment('TEST_DATABASE_API_URL')
const apiRoleName = requiredEnvironment('TEST_DATABASE_API_ROLE')
const canaryId = requiredEnvironment('VIBE_WRITER_MEMORY_API_CANARY_ID')
if (!/^[0-9a-f]{32}$/.test(canaryId) || !/^[a-z][a-z0-9_]{0,62}$/.test(apiRoleName)) {
  throw new Error('Memory API canary identifiers are invalid')
}

const ownerDatabase = createPostgresDatabase(ownerDatabaseUrl, { max: 2 })
const apiDatabase = createPostgresDatabase(apiDatabaseUrl, { max: 2 })
const childProcesses: ChildProcess[] = []
const servers: HttpServer[] = []

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a canary port'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Canary child did not stop after SIGTERM'))
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function runCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(
        `${command} exited with ${code ?? signal}: ${stderr.trim()}`,
      ))
    })
  })
}

function commandReport(output: string): Record<string, unknown> {
  const line = output.split('\n').findLast((entry) => entry.trim().startsWith('{'))
  if (!line) throw new Error(`Command did not emit a JSON report: ${output}`)
  return JSON.parse(line) as Record<string, unknown>
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}

async function waitForHttp(url: string, expectedStatus = 200): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.status === expectedStatus) return response
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError ?? new Error(`${url} did not become available`)
}

function startNext(port: number): { child: ChildProcess; output: () => string } {
  const cleanEnvironment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
      'DATABASE_URL',
      'DATABASE_API_URL',
      'DURABLE_API_ENABLED',
      'DURABLE_ARTICLE_READ_ENABLED',
      'DURABLE_MEMORY_SIGNAL_API_ENABLED',
      'DURABLE_MEMORY_MANAGEMENT_API_ENABLED',
      'DURABLE_AUTH_MODE',
      'MEMORY_CONSENT_POLICY_VERSION',
  ]) delete cleanEnvironment[key]
  const child: ChildProcess = spawn('pnpm', [
    '--filter', '@vibe-writer/web', 'exec',
    'next', 'start', '-H', '127.0.0.1', '-p', String(port),
  ], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...cleanEnvironment,
      DATABASE_API_URL: apiDatabaseUrl,
      DURABLE_API_ENABLED: 'true',
      DURABLE_ARTICLE_READ_ENABLED: 'true',
      DURABLE_MEMORY_SIGNAL_API_ENABLED: 'true',
      DURABLE_MEMORY_MANAGEMENT_API_ENABLED: 'true',
      DURABLE_AUTH_MODE: 'trusted-proxy',
      MEMORY_CONSENT_POLICY_VERSION: 'memory-consent-v1',
    },
  })
  childProcesses.push(child)
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  return { child, output: () => output }
}

function startHeaderStrippingProxy(
  port: number,
  nextOrigin: string,
  sessions: Map<string, { principalId: string; workspaceId: string }>,
): Promise<HttpServer> {
  const target = new URL(nextOrigin)
  const server = createHttpServer((incoming, outgoing) => {
    const headers = { ...incoming.headers }
    const rawSession = headers['x-canary-session']
    const sessionKey = Array.isArray(rawSession) ? rawSession[0] : rawSession
    const identity = sessionKey ? sessions.get(sessionKey) : undefined
    delete headers['x-canary-session']
    delete headers['x-vibe-principal-id']
    delete headers['x-vibe-workspace-id']
    headers.host = target.host
    if (identity) {
      headers['x-vibe-principal-id'] = identity.principalId
      headers['x-vibe-workspace-id'] = identity.workspaceId
    }
    const upstream = requestHttp({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: incoming.method,
      path: incoming.url,
      headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    })
    upstream.on('error', (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end(error.message)
    })
    incoming.pipe(upstream)
  })
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

function canaryRequest(
  origin: string,
  path: string,
  session?: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (session) headers.set('x-canary-session', session)
  headers.set('x-vibe-principal-id', '00000000-0000-4000-8000-000000000099')
  headers.set('x-vibe-workspace-id', '00000000-0000-4000-8000-000000000098')
  if (init.body) headers.set('content-type', 'application/json')
  return fetch(`${origin}${path}`, { ...init, headers, cache: 'no-store' })
}

async function provisionMember(
  workspace: AuthorizedWorkspaceScope | undefined,
  role: 'owner' | 'editor' | 'viewer',
): Promise<AuthorizedWorkspaceScope> {
  return createWorkspaceRepository(ownerDatabase.db).provision({
    principalId: randomUUID(),
    workspaceId: workspace?.workspaceId ?? randomUUID(),
    slug: workspace
      ? 'ignored-existing-canary-workspace'
      : `memory-canary-${canaryId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    name: workspace ? 'Ignored existing canary workspace' : 'Memory API canary workspace',
    role,
  })
}

afterAll(async () => {
  await Promise.allSettled(servers.splice(0).map(closeServer))
  await Promise.allSettled(childProcesses.splice(0).map(stopProcess))
  await Promise.allSettled([apiDatabase.close(), ownerDatabase.close()])
})

describe('real Next.js Memory API canary', () => {
  it('enforces exact DB privileges, proxy identity stripping, RLS, and role governance', async () => {
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
    if (
      target?.address !== '127.0.0.1' ||
      target.comment !== `vibe-writer-memory-api-canary:${canaryId}`
    ) {
      throw new Error(`Refusing Memory API canary target ${JSON.stringify(target)}`)
    }

    await migrateVibePostgresDatabase(ownerDatabase.db)
    durableApiRoleProvisioningStatements(apiRoleName)
    await ownerDatabase.client.unsafe(`CREATE ROLE ${apiRoleName} LOGIN`)
    const provisionOutput = await runCommand(
      'pnpm',
      ['--filter', '@vibe-writer/db', 'durable-api-role:provision'],
      {
        ...process.env,
        DATABASE_ADMIN_URL: ownerDatabaseUrl,
        DURABLE_API_ROLE: apiRoleName,
      },
    )
    expect(commandReport(provisionOutput)).toMatchObject({ status: 'provisioned' })
    const verifyOutput = await runCommand(
      'pnpm',
      ['--filter', '@vibe-writer/db', 'durable-api-role:verify'],
      {
        ...process.env,
        DATABASE_API_URL: apiDatabaseUrl,
        DURABLE_API_ROLE: apiRoleName,
      },
    )
    expect(commandReport(verifyOutput)).toMatchObject({ status: 'verified' })
    const roleVerification = await assertCurrentDurableApiRole(
      apiDatabase.client,
      apiRoleName,
    )
    expect(roleVerification.issues).toEqual([])

    const owner = await provisionMember(undefined, 'owner')
    const editor = await provisionMember(owner, 'editor')
    const viewer = await provisionMember(owner, 'viewer')
    const outsider = await provisionMember(undefined, 'owner')
    const seededSignal = await createMemorySourceSignalRepository(ownerDatabase.db).create(
      editor,
      {
        idempotencyKey: 'canary-seeded-candidate-source',
        sourceKind: 'explicit_remember',
        subject: { kind: 'workspace', key: 'default' },
        text: 'Remember that concise technical explanations are preferred.',
        consentPolicyVersion: 'memory-consent-v1',
        retentionDays: 30,
      },
    )
    const submitted = await createMemoryRepository(ownerDatabase.db).submitProposal({
      schemaVersion: 2,
      workspaceId: owner.workspaceId,
      subject: { kind: 'workspace', key: 'default' },
      memoryKey: 'writing.tone',
      kind: 'preference',
      content: 'Prefer concise technical explanations.',
      proposedBy: 'user',
      confidence: 1,
      sensitivity: 'normal',
      consent: { basis: 'explicit_user', policyVersion: 'memory-consent-v1' },
      source: {
        kind: 'signal',
        signalId: seededSignal.signal.id,
        evidenceFingerprint: seededSignal.signal.evidenceFingerprint,
      },
      extractor: { key: 'memory-api-canary', version: 'v1' },
      expiresAt: new Date(
        seededSignal.signal.retentionUntil.getTime() - 1_000,
      ).toISOString(),
    })
    if (submitted.status !== 'candidate') throw new Error('Canary candidate was not created')

    const nextPort = await reservePort()
    const proxyPort = await reservePort()
    const next = startNext(nextPort)
    const nextOrigin = `http://127.0.0.1:${nextPort}`
    await waitForHttp(`${nextOrigin}/api/durable/health/live`)
    await startHeaderStrippingProxy(proxyPort, nextOrigin, new Map<
      string,
      { principalId: string; workspaceId: string }
    >([
      ['owner', owner],
      ['editor', editor],
      ['viewer', viewer],
      ['outsider', outsider],
      ['mismatch', { principalId: viewer.principalId, workspaceId: outsider.workspaceId }],
    ]))
    const origin = `http://127.0.0.1:${proxyPort}`
    const ready = await waitForHttp(`${origin}/api/durable/health/ready`)
    expect(await json(ready)).toMatchObject({ status: 'ready' })

    const spoofOnly = await canaryRequest(origin, '/api/durable/memory/policy')
    expect(spoofOnly.status).toBe(401)
    const mismatched = await canaryRequest(origin, '/api/durable/memory/policy', 'mismatch')
    expect(mismatched.status).toBe(403)

    const viewerPolicy = await canaryRequest(origin, '/api/durable/memory/policy', 'viewer')
    expect(viewerPolicy.status).toBe(200)
    expect(viewerPolicy.headers.get('cache-control')).toBe('no-store')
    expect(await json(viewerPolicy)).toMatchObject({
      policy: { version: 'memory-consent-v1' },
      workspace: {
        role: 'viewer',
        capabilities: {
          read_active_memories: true,
          review_candidates: false,
          delete_active_memories: false,
          manage_own_signals: true,
          create_shared_signals: false,
        },
      },
    })

    const viewerCandidates = await canaryRequest(
      origin,
      '/api/durable/memory/candidates',
      'viewer',
    )
    expect(viewerCandidates.status).toBe(403)
    const viewerSharedSignal = await canaryRequest(
      origin,
      '/api/durable/memory/signals',
      'viewer',
      {
        method: 'POST',
        headers: { 'idempotency-key': 'viewer-shared-signal' },
        body: JSON.stringify({
          source_kind: 'explicit_remember',
          subject: { kind: 'workspace', key: 'default' },
          text: 'This viewer must not create a shared signal.',
          consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
          retention_days: 30,
        }),
      },
    )
    expect(viewerSharedSignal.status).toBe(403)

    const viewerPersonalSignal = await canaryRequest(
      origin,
      '/api/durable/memory/signals',
      'viewer',
      {
        method: 'POST',
        headers: { 'idempotency-key': 'viewer-personal-signal' },
        body: JSON.stringify({
          source_kind: 'preference_setting',
          subject: { kind: 'principal', key: viewer.principalId },
          text: 'Use short paragraphs in my drafts.',
          consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
          retention_days: 30,
        }),
      },
    )
    expect(viewerPersonalSignal.status).toBe(201)
    const personalSignalBody = await json(viewerPersonalSignal)
    const personalSignal = personalSignalBody.signal as { id: string }

    const editorCandidates = await canaryRequest(
      origin,
      '/api/durable/memory/candidates',
      'editor',
    )
    expect(editorCandidates.status).toBe(200)
    const candidateBody = await json(editorCandidates)
    expect(candidateBody).toMatchObject({
      candidates: [{ id: submitted.candidate.id, content: 'Prefer concise technical explanations.' }],
    })
    expect(JSON.stringify(candidateBody)).not.toContain(seededSignal.signal.id)
    expect(JSON.stringify(candidateBody)).not.toContain(seededSignal.signal.evidenceFingerprint)
    expect(JSON.stringify(candidateBody)).not.toContain(editor.principalId)

    const materialized = await canaryRequest(
      origin,
      `/api/durable/memory/candidates/${submitted.candidate.id}/review`,
      'editor',
      {
        method: 'POST',
        body: JSON.stringify({
          decision: 'materialize',
          reason_code: 'confirmed_preference',
        }),
      },
    )
    if (materialized.status !== 200) {
      throw new Error(
        `Memory materialization returned ${materialized.status}: ${await materialized.text()}\n${next.output()}`,
      )
    }
    const materializedBody = await json(materialized)
    const memoryId = materializedBody.memory_id as string

    const active = await canaryRequest(origin, '/api/durable/memory', 'viewer')
    expect(active.status).toBe(200)
    const activeBody = await json(active)
    expect(activeBody).toMatchObject({
      memories: [{ id: memoryId, content: 'Prefer concise technical explanations.' }],
    })
    expect(JSON.stringify(activeBody)).not.toContain('fingerprint')
    expect(JSON.stringify(activeBody)).not.toContain(submitted.candidate.id)

    const isolated = await canaryRequest(origin, '/api/durable/memory', 'outsider')
    expect(isolated.status).toBe(200)
    expect(await json(isolated)).toMatchObject({ memories: [] })

    const editorDelete = await canaryRequest(
      origin,
      `/api/durable/memory/${memoryId}`,
      'editor',
      {
        method: 'DELETE',
        body: JSON.stringify({ reason_code: 'user_requested_erasure' }),
      },
    )
    expect(editorDelete.status).toBe(403)
    const ownerDelete = await canaryRequest(
      origin,
      `/api/durable/memory/${memoryId}`,
      'owner',
      {
        method: 'DELETE',
        body: JSON.stringify({ reason_code: 'user_requested_erasure' }),
      },
    )
    expect(ownerDelete.status).toBe(200)
    const ownerDeleteBody = await json(ownerDelete)
    expect(ownerDeleteBody).toMatchObject({ status: 'deleted', memory_id: memoryId })
    expect(JSON.stringify(ownerDeleteBody)).not.toContain('fingerprint')
    expect(JSON.stringify(ownerDeleteBody)).not.toContain('Prefer concise')

    const signalDelete = await canaryRequest(
      origin,
      `/api/durable/memory/signals/${personalSignal.id}`,
      'viewer',
      {
        method: 'DELETE',
        body: JSON.stringify({ reason_code: 'user_revoked' }),
      },
    )
    if (signalDelete.status !== 200) {
      let repositoryDiagnostic = 'repository replay unexpectedly succeeded'
      try {
        await createMemorySourceSignalRepository(apiDatabase.db).delete(viewer, {
          sourceSignalId: personalSignal.id,
          reasonCode: 'user_revoked',
        })
      } catch (error) {
        repositoryDiagnostic = error instanceof Error
          ? `${error.message}${error.cause ? `; cause=${String(error.cause)}` : ''}`
          : String(error)
      }
      throw new Error(
        `Memory signal deletion returned ${signalDelete.status}: ${await signalDelete.text()}\n${repositoryDiagnostic}\n${next.output()}`,
      )
    }
    expect(await json(signalDelete)).toMatchObject({
      status: 'deleted',
      source_signal_id: personalSignal.id,
    })

    await stopProcess(next.child).catch((error) => {
      throw new Error(`${String(error)}\n${next.output()}`)
    })
  })
})
