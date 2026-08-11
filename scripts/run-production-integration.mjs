import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (!Array.isArray(articles) || articles.length !== 3) {
    throw new Error(`Unexpected durable article list: ${JSON.stringify(articles)}`)
  }
  const generatedArticles = articles.filter((article) => article.topic === '稳定写作')
  const resumedArticle = articles.find((article) => article.topic === '人工确认')
  if (
    generatedArticles.length !== 2 || generatedArticles.some((article) => !article.id) ||
    new Set(generatedArticles.map((article) => article.job_id)).size !== 2 ||
    !resumedArticle?.id
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
