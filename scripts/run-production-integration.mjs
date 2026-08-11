import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const testId = randomBytes(16).toString('hex')
const databaseName = `vibe_writer_production_${testId}`
const containerName = `vibe-writer-production-redis-${testId}`
const redisImage = 'redis:7.4-alpine'
const systemPrincipalId = '00000000-0000-4000-8000-000000000001'
const systemWorkspaceId = '00000000-0000-4000-8000-000000000002'
const identityHeaders = {
  'x-vibe-principal-id': systemPrincipalId,
  'x-vibe-workspace-id': systemWorkspaceId,
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`))
    })
  })
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  return { child, output: () => output }
}

async function waitForHttp(url, expectedStatus = 200, init = {}) {
  let lastError
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store', ...init })
      if (response.status === expectedStatus) return response
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError ?? new Error(`${url} did not become available`)
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Child process did not stop after SIGTERM'))
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a local integration port'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function isPostgresRunning(dataDirectory) {
  return new Promise((resolve) => {
    const child = spawn('pg_ctl', ['-D', dataDirectory, 'status'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

async function waitForRedis() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const pong = await run(
        'docker',
        ['exec', containerName, 'redis-cli', '--raw', 'ping'],
        { capture: true },
      )
      if (pong === 'PONG') return
    } catch {
      // Container startup is expected to race the first probes.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Redis container did not become ready')
}

let temporaryRoot
let dataDirectory
let redisStarted = false
let webProcess

try {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'vibe-writer-production-'))
  dataDirectory = join(temporaryRoot, 'postgres')
  const postgresPort = await reservePort()
  const workerHealthPort = await reservePort()
  const webPort = await reservePort()
  const logPath = join(temporaryRoot, 'postgres.log')

  await run('initdb', [
    '-D', dataDirectory,
    '--no-locale',
    '--encoding=UTF8',
    '--auth=trust',
  ])
  await run('pg_ctl', [
    '-D', dataDirectory,
    '-l', logPath,
    '-o', `-F -p ${postgresPort} -h 127.0.0.1`,
    '-w', 'start',
  ])
  await run('createdb', [
    '-h', '127.0.0.1',
    '-p', String(postgresPort),
    databaseName,
  ])
  await run('psql', [
    '-h', '127.0.0.1',
    '-p', String(postgresPort),
    '-d', databaseName,
    '-v', 'ON_ERROR_STOP=1',
    '-c', `COMMENT ON DATABASE ${databaseName} IS 'vibe-writer-production:${testId}'`,
  ])

  await run('docker', [
    'run', '--detach', '--rm',
    '--name', containerName,
    '--label', `vibe-writer.production-integration=${testId}`,
    '--publish', '127.0.0.1::6379',
    redisImage,
    'redis-server', '--save', '', '--appendonly', 'no',
  ], { capture: true })
  redisStarted = true
  await waitForRedis()
  const portLine = await run('docker', ['port', containerName, '6379/tcp'], {
    capture: true,
  })
  const redisPort = portLine.match(/127\.0\.0\.1:(\d+)$/)?.[1]
  if (!redisPort) throw new Error(`Unexpected Redis port mapping: ${portLine}`)

  await run('pnpm', ['--filter', '@vibe-writer/worker', 'test:production'], {
    env: {
      TEST_DATABASE_URL: `postgres://127.0.0.1:${postgresPort}/${databaseName}`,
      TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      TEST_WORKER_HEALTH_PORT: String(workerHealthPort),
      VIBE_WRITER_PRODUCTION_TEST_ID: testId,
    },
  })

  const legacySource = join(temporaryRoot, 'legacy-articles.db')
  const legacySqlite = new DatabaseSync(legacySource)
  legacySqlite.exec(`
    CREATE TABLE articles (
      id VARCHAR PRIMARY KEY, job_id VARCHAR UNIQUE NOT NULL, topic TEXT NOT NULL,
      content TEXT NOT NULL, word_count INTEGER NOT NULL, created_at DATETIME NOT NULL
    );
    CREATE TABLE article_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, article_id VARCHAR NOT NULL,
      content TEXT NOT NULL, word_count INTEGER NOT NULL, saved_at DATETIME NOT NULL
    );
    INSERT INTO articles VALUES (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'Legacy migration fixture', '# Legacy current', 13,
      '2026-04-01 08:00:00.000000'
    );
    INSERT INTO article_versions (article_id, content, word_count, saved_at) VALUES (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '# Legacy original', 14,
      '2026-04-02 08:00:00.000000'
    );
  `)
  legacySqlite.close()
  const migrationCommand = [
    '--filter', '@vibe-writer/worker', 'exec', 'tsx',
    'src/migrate-legacy-articles.ts', '--source', legacySource,
  ]
  const migrationEnv = {
    LEGACY_MIGRATION_DATABASE_URL: `postgres://127.0.0.1:${postgresPort}/${databaseName}`,
  }
  const dryRunOutput = await run('pnpm', migrationCommand, {
    capture: true,
    env: migrationEnv,
  })
  const dryRunReport = JSON.parse(dryRunOutput)
  if (dryRunReport.mode !== 'dry-run' || dryRunReport.wouldImport !== 1 || dryRunReport.imported !== 0) {
    throw new Error(`Unexpected legacy dry-run report: ${dryRunOutput}`)
  }
  const applyOutput = await run('pnpm', [
    ...migrationCommand,
    '--apply', '--expected-source-sha256', dryRunReport.sourceSha256,
  ], {
    capture: true,
    env: { ...migrationEnv, ALLOW_LEGACY_SQLITE_IMPORT: 'true' },
  })
  const applyReport = JSON.parse(applyOutput)
  if (applyReport.mode !== 'apply' || applyReport.imported !== 1) {
    throw new Error(`Unexpected legacy apply report: ${applyOutput}`)
  }
  const replayOutput = await run('pnpm', [
    ...migrationCommand,
    '--apply', '--expected-source-sha256', dryRunReport.sourceSha256,
  ], {
    capture: true,
    env: { ...migrationEnv, ALLOW_LEGACY_SQLITE_IMPORT: 'true' },
  })
  const replayReport = JSON.parse(replayOutput)
  if (replayReport.imported !== 0 || replayReport.replayed !== 1) {
    throw new Error(`Unexpected legacy replay report: ${replayOutput}`)
  }

  await run('pnpm', ['build:web'], {
    env: { NEXT_PUBLIC_API_BASE: '/api/durable' },
  })
  webProcess = start('pnpm', [
    '--filter', '@vibe-writer/web', 'exec',
    'next', 'start', '-H', '127.0.0.1', '-p', String(webPort),
  ], {
    env: {
      DATABASE_URL: `postgres://127.0.0.1:${postgresPort}/${databaseName}`,
      DURABLE_API_ENABLED: 'true',
      DURABLE_ARTICLE_READ_ENABLED: 'true',
      DURABLE_AUTH_MODE: 'trusted-proxy',
    },
  })
  webProcess.child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`)
  })
  const webOrigin = `http://127.0.0.1:${webPort}`
  await waitForHttp(`${webOrigin}/api/durable/health/live`)
  const ready = await waitForHttp(`${webOrigin}/api/durable/health/ready`)
  const readyBody = await ready.json()
  if (readyBody.status !== 'ready') {
    throw new Error(`Unexpected durable readiness: ${JSON.stringify(readyBody)}`)
  }
  const articlesResponse = await waitForHttp(
    `${webOrigin}/api/durable/articles`,
    200,
    { headers: identityHeaders },
  )
  const articles = await articlesResponse.json()
  if (!Array.isArray(articles) || articles.length !== 4) {
    throw new Error(`Unexpected durable article list: ${JSON.stringify(articles)}`)
  }
  const generatedArticles = articles.filter((article) => article.topic === '稳定写作')
  const resumedArticle = articles.find((article) => article.topic === '人工确认')
  const legacyArticle = articles.find((article) => article.topic === 'Legacy migration fixture')
  if (
    generatedArticles.length !== 2 || generatedArticles.some((article) => !article.id) ||
    new Set(generatedArticles.map((article) => article.job_id)).size !== 2 ||
    !resumedArticle?.id ||
    legacyArticle?.id !== 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) {
    throw new Error(`Durable article identities were not preserved: ${JSON.stringify(articles)}`)
  }
  for (const generatedArticle of generatedArticles) {
    const articlePage = await waitForHttp(
      `${webOrigin}/articles/${generatedArticle.id}`,
      200,
      { headers: identityHeaders },
    )
    const articleHtml = await articlePage.text()
    if (!articleHtml.includes('稳定写作')) {
      throw new Error('Server-rendered article did not use the durable PostgreSQL source')
    }
  }
  const resumedPage = await waitForHttp(
    `${webOrigin}/articles/${resumedArticle.id}`,
    200,
    { headers: identityHeaders },
  )
  const resumedHtml = await resumedPage.text()
  if (!resumedHtml.includes('人工确认') || !resumedHtml.includes('编辑章')) {
    throw new Error('Server-rendered article did not preserve the resumed outline')
  }
  const legacyPage = await waitForHttp(
    `${webOrigin}/articles/${legacyArticle.id}`,
    200,
    { headers: identityHeaders },
  )
  const legacyHtml = await legacyPage.text()
  if (!legacyHtml.includes('Legacy migration fixture')) {
    throw new Error('Server-rendered article did not preserve the migrated legacy identity')
  }
} finally {
  if (webProcess) {
    try {
      await stop(webProcess.child)
    } catch (error) {
      console.error(error instanceof Error ? `${error.message}\n${webProcess.output()}` : error)
    }
  }
  if (redisStarted && /^vibe-writer-production-redis-[0-9a-f]{32}$/.test(containerName)) {
    try {
      await run('docker', ['stop', '--time', '5', containerName], { capture: true })
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
    }
  }

  let stopError
  if (dataDirectory && await isPostgresRunning(dataDirectory)) {
    try {
      await run('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'])
    } catch (error) {
      stopError = error
      console.error(error instanceof Error ? error.message : error)
    }
  }
  const postgresStillRunning = dataDirectory
    ? await isPostgresRunning(dataDirectory)
    : false
  if (temporaryRoot && !postgresStillRunning) {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  if (postgresStillRunning) {
    throw new Error(
      `PostgreSQL integration server is still running; preserved ${temporaryRoot}`,
      { cause: stopError },
    )
  }
}
