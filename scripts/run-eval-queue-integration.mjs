import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const testId = randomBytes(16).toString('hex')
const databaseName = `vibe_writer_eval_${testId}`
const containerName = `vibe-writer-eval-redis-${testId}`
const image = 'redis:7.4-alpine'

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
      else reject(new Error(`${command} exited ${code ?? signal}: ${stderr.trim()}`))
    })
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
        reject(new Error('Could not allocate an Eval integration port'))
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

try {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'vibe-writer-eval-runtime-'))
  dataDirectory = join(temporaryRoot, 'postgres')
  const postgresPort = await reservePort()
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
    '-c', `COMMENT ON DATABASE ${databaseName} IS 'vibe-writer-eval-runtime:${testId}'`,
  ])

  await run('docker', [
    'run', '--detach', '--rm',
    '--name', containerName,
    '--label', `vibe-writer.eval-integration=${testId}`,
    '--publish', '127.0.0.1::6379',
    image,
    'redis-server', '--save', '', '--appendonly', 'no',
  ], { capture: true })
  redisStarted = true
  await waitForRedis()
  const portLine = await run('docker', ['port', containerName, '6379/tcp'], {
    capture: true,
  })
  const redisPort = portLine.match(/127\.0\.0\.1:(\d+)$/)?.[1]
  if (!redisPort) throw new Error(`Unexpected Redis port mapping: ${portLine}`)

  const testRedisUrl = `redis://127.0.0.1:${redisPort}`
  await run('pnpm', ['--filter', '@vibe-writer/eval-cli', 'test:redis'], {
    env: {
      TEST_REDIS_URL: testRedisUrl,
      VIBE_WRITER_EVAL_REDIS_TEST_ID: testId,
    },
  })
  await run('pnpm', ['--filter', '@vibe-writer/eval-cli', 'test:runtime-roles'], {
    env: {
      TEST_DATABASE_URL: `postgres://127.0.0.1:${postgresPort}/${databaseName}`,
      TEST_REDIS_URL: testRedisUrl,
      VIBE_WRITER_EVAL_RUNTIME_TEST_ID: testId,
    },
  })
} finally {
  if (redisStarted && /^vibe-writer-eval-redis-[0-9a-f]{32}$/.test(containerName)) {
    try {
      await run('docker', ['stop', '--time', '5', containerName], { capture: true })
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
    }
  }
  let stopError
  if (dataDirectory && (await isPostgresRunning(dataDirectory))) {
    try {
      await run('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'])
    } catch (error) {
      stopError = error
      console.error(error instanceof Error ? error.message : error)
    }
  }
  const stillRunning = dataDirectory ? await isPostgresRunning(dataDirectory) : false
  if (temporaryRoot && !stillRunning) {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  if (stillRunning) {
    throw new Error(
      `PostgreSQL test server is still running; preserved its data at ${temporaryRoot}`,
      { cause: stopError },
    )
  }
}
