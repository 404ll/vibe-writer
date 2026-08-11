import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const composeFile = resolve(repositoryRoot, 'compose.durable.yml')
const systemPrincipalId = '00000000-0000-4000-8000-000000000001'
const systemWorkspaceId = '00000000-0000-4000-8000-000000000002'

const databaseAdminUrl =
  'postgresql://vibe_writer_admin:vibe_writer_dev_admin@127.0.0.1:54329/vibe_writer'
const databaseApiUrl =
  'postgresql://vibe_writer_api:vibe_writer_dev_api@127.0.0.1:54329/vibe_writer'
const databaseDispatcherUrl =
  'postgresql://vibe_writer_write_dispatcher:vibe_writer_dev_dispatcher@127.0.0.1:54329/vibe_writer'
const databaseConsumerUrl =
  'postgresql://vibe_writer_write_consumer:vibe_writer_dev_consumer@127.0.0.1:54329/vibe_writer'

const databaseEnvironment = {
  DATABASE_ADMIN_URL: databaseAdminUrl,
  DATABASE_CHECKPOINT_ADMIN_URL: databaseAdminUrl,
  DATABASE_API_URL: databaseApiUrl,
  DURABLE_API_ROLE: 'vibe_writer_api',
  DURABLE_API_ROLE_PASSWORD: 'vibe_writer_dev_api',
  DATABASE_WRITE_DISPATCHER_URL: databaseDispatcherUrl,
  WRITE_DISPATCHER_DATABASE_ROLE: 'vibe_writer_write_dispatcher',
  WRITE_DISPATCHER_DATABASE_PASSWORD: 'vibe_writer_dev_dispatcher',
  DATABASE_WRITE_CONSUMER_URL: databaseConsumerUrl,
  WRITE_CONSUMER_DATABASE_ROLE: 'vibe_writer_write_consumer',
  WRITE_CONSUMER_DATABASE_PASSWORD: 'vibe_writer_dev_consumer',
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function loadProviderEnvironment() {
  const requested = argument('--env-file') ?? process.env.DURABLE_DEV_ENV_FILE
  const defaultFile = resolve(repositoryRoot, '.env')
  const envFile = requested ? resolve(requested) : defaultFile
  if (requested || existsSync(envFile)) {
    if (!existsSync(envFile)) throw new Error(`Durable dev env file not found: ${envFile}`)
    process.loadEnvFile(envFile)
  }
  for (const name of ['ANTHROPIC_API_KEY', 'MODEL_ID']) {
    if (!process.env[name]?.trim()) {
      throw new Error(`${name} is required; set it in .env or pass --env-file`)
    }
  }
  return requested || existsSync(defaultFile) ? envFile : null
}

function run(command, args, extraEnvironment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnvironment },
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

function start(command, args, extraEnvironment = {}) {
  return spawn(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnvironment },
  })
}

async function waitForHttp(url) {
  let lastError
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      if (response.ok) return
      lastError = new Error(`${url} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw lastError ?? new Error(`${url} did not become ready`)
}

function waitForExit(child, name) {
  return new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      resolvePromise({ name, code, signal })
    })
  })
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolvePromise()
    })
    child.kill('SIGTERM')
  })
}

const envFile = loadProviderEnvironment()
await run('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait'])
await run('pnpm', [
  '--filter', '@vibe-writer/db', 'durable-dev:prepare',
], databaseEnvironment)
await run('pnpm', ['setup:checkpoint-schema'], databaseEnvironment)
await run('pnpm', [
  '--filter', '@vibe-writer/db', 'durable-dev:provision',
], databaseEnvironment)

const worker = start('pnpm', ['start:worker'], {
  ...databaseEnvironment,
  DURABLE_WORKER_ENABLED: 'true',
  DURABLE_WORKER_ROLE: 'all',
  REDIS_URL: 'redis://127.0.0.1:6389/0',
  WORKER_ID: 'vibe-writer-local-durable',
  CODE_REVISION: 'local-durable-dev',
  WORKER_HEALTH_HOST: '127.0.0.1',
  WORKER_HEALTH_PORT: '3001',
  WORKER_CONCURRENCY: '1',
  OUTBOX_POLL_MS: '100',
})
const web = start('pnpm', [
  '--filter', '@vibe-writer/web', 'exec',
  'next', 'dev', '-H', '127.0.0.1', '-p', '3000',
], {
  NEXT_PUBLIC_API_BASE: '/api/durable',
  DURABLE_API_ENABLED: 'true',
  DURABLE_ARTICLE_READ_ENABLED: 'true',
  DURABLE_MEMORY_SIGNAL_API_ENABLED: 'false',
  DURABLE_MEMORY_MANAGEMENT_API_ENABLED: 'false',
  DURABLE_AUTH_MODE: 'local-development',
  DURABLE_LOCAL_PRINCIPAL_ID: systemPrincipalId,
  DURABLE_LOCAL_WORKSPACE_ID: systemWorkspaceId,
  DATABASE_API_URL: databaseApiUrl,
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([stop(web), stop(worker)])
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0))
  })
}

try {
  await Promise.all([
    waitForHttp('http://127.0.0.1:3001/ready'),
    waitForHttp('http://127.0.0.1:3000/api/durable/health/ready'),
  ])
  process.stdout.write(
    `\nDurable MVP ready: http://127.0.0.1:3000\n` +
    `Provider config: ${envFile ?? 'process environment'}\n` +
    `PostgreSQL and Redis data persist across restarts.\n\n`,
  )
  const exit = await Promise.race([
    waitForExit(web, 'Next.js'),
    waitForExit(worker, 'Worker'),
  ])
  if (!shuttingDown) {
    throw new Error(`${exit.name} stopped unexpectedly (${exit.code ?? exit.signal})`)
  }
} finally {
  await shutdown()
}
