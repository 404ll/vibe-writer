import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const canaryId = randomBytes(16).toString('hex')
const databaseName = `vibe_writer_memory_retention_${canaryId}`
const retentionRoleName = `vibe_writer_retention_${canaryId.slice(0, 16)}`

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      env: { ...process.env, ...options.env },
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
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
        reject(new Error('Could not allocate a PostgreSQL canary port'))
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

let temporaryRoot
let dataDirectory

try {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'vibe-writer-memory-retention-'))
  dataDirectory = join(temporaryRoot, 'postgres')
  const port = await reservePort()
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
    '-o', `-F -p ${port} -h 127.0.0.1`,
    '-w', 'start',
  ])
  await run('createdb', ['-h', '127.0.0.1', '-p', String(port), databaseName])
  await run('psql', [
    '-h', '127.0.0.1',
    '-p', String(port),
    '-d', databaseName,
    '-v', 'ON_ERROR_STOP=1',
    '-c', `COMMENT ON DATABASE ${databaseName} IS 'vibe-writer-memory-retention-canary:${canaryId}'`,
  ])

  const ownerUrl = `postgres://127.0.0.1:${port}/${databaseName}`
  const retentionUrl = `postgres://${retentionRoleName}@127.0.0.1:${port}/${databaseName}`
  await run('pnpm', [
    '--filter', '@vibe-writer/worker', 'exec', 'vitest', 'run',
    'tests/memory-retention-role.postgres.integration.test.ts',
  ], {
    env: {
      TEST_DATABASE_OWNER_URL: ownerUrl,
      TEST_DATABASE_MEMORY_RETENTION_URL: retentionUrl,
      TEST_DATABASE_MEMORY_RETENTION_ROLE: retentionRoleName,
      VIBE_WRITER_MEMORY_RETENTION_CANARY_ID: canaryId,
    },
  })
} finally {
  let stopError
  if (dataDirectory && await isPostgresRunning(dataDirectory)) {
    try {
      await run('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'])
    } catch (error) {
      stopError = error
      process.stderr.write(`${error.message}\n`)
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
      `Memory retention canary PostgreSQL is still running; preserved ${temporaryRoot}`,
      { cause: stopError },
    )
  }
}
