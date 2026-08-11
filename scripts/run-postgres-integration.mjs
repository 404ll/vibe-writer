import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      ...options,
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
        reject(new Error('Could not allocate a PostgreSQL test port'))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
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
  temporaryRoot = await mkdtemp(join(tmpdir(), 'vibe-writer-postgres-'))
  dataDirectory = join(temporaryRoot, 'data')
  const logPath = join(temporaryRoot, 'postgres.log')
  const destructiveTestId = randomUUID().replaceAll('-', '')
  const databaseName = `vibe_writer_integration_${destructiveTestId}`
  const port = await reservePort()

  await run('initdb', [
    '-D',
    dataDirectory,
    '--no-locale',
    '--encoding=UTF8',
    '--auth=trust',
  ])
  await run('pg_ctl', [
    '-D',
    dataDirectory,
    '-l',
    logPath,
    '-o',
    `-F -p ${port} -h 127.0.0.1`,
    '-w',
    'start',
  ])
  await run('createdb', ['-h', '127.0.0.1', '-p', String(port), databaseName])
  await run('psql', [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-d',
    databaseName,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `COMMENT ON DATABASE ${databaseName} IS 'vibe-writer-ephemeral:${destructiveTestId}'`,
  ])

  const testDatabaseUrl = `postgres://127.0.0.1:${port}/${databaseName}`
  await run('pnpm', ['--filter', '@vibe-writer/db', 'test:postgres'], {
    env: {
      ...process.env,
      TEST_DATABASE_URL: testDatabaseUrl,
      VIBE_WRITER_POSTGRES_TEST_ID: destructiveTestId,
    },
  })
  await run('pnpm', ['--filter', '@vibe-writer/checkpoint-runtime', 'test:postgres'], {
    env: {
      ...process.env,
      TEST_DATABASE_URL: testDatabaseUrl,
      VIBE_WRITER_POSTGRES_TEST_ID: destructiveTestId,
    },
  })
  await run('pnpm', ['--filter', '@vibe-writer/eval-cli', 'test:live-sampler:postgres'], {
    env: {
      ...process.env,
      TEST_DATABASE_URL: testDatabaseUrl,
      VIBE_WRITER_POSTGRES_TEST_ID: destructiveTestId,
    },
  })
  const evalEnvironment = {
    ...process.env,
    EVAL_DATABASE_URL: testDatabaseUrl,
    EVAL_NAMESPACE_KEY: 'integration:component-regression',
  }
  await run('pnpm', ['eval:components:register'], { env: evalEnvironment })
  await run('pnpm', ['eval:components:register'], { env: evalEnvironment })
  const enqueueEnvironment = {
    ...evalEnvironment,
    EVAL_IDEMPOTENCY_KEY: 'integration:component-regression:queued:v1',
  }
  await run('pnpm', ['eval:components:enqueue'], { env: enqueueEnvironment })
  await run('pnpm', ['eval:components:enqueue'], { env: enqueueEnvironment })
  await run('psql', [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-d',
    databaseName,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `DO $$
    BEGIN
      IF (SELECT count(*) FROM eval_suites WHERE namespace_key = 'integration:component-regression') <> 1 THEN
        RAISE EXCEPTION 'expected one idempotent eval suite';
      END IF;
      IF (
        SELECT count(*) FROM eval_cases cases
        INNER JOIN eval_suites suites ON suites.id = cases.suite_id
        WHERE suites.namespace_key = 'integration:component-regression'
      ) <> 38 THEN
        RAISE EXCEPTION 'expected 38 eval cases';
      END IF;
      IF (
        SELECT count(*) FROM eval_runs runs
        INNER JOIN eval_suites suites ON suites.id = runs.suite_id
        WHERE suites.namespace_key = 'integration:component-regression'
          AND runs.status = 'completed'
      ) <> 2 THEN
        RAISE EXCEPTION 'expected two completed eval runs';
      END IF;
      IF (
        SELECT count(*) FROM eval_runs runs
        INNER JOIN eval_suites suites ON suites.id = runs.suite_id
        WHERE suites.namespace_key = 'integration:component-regression'
          AND runs.mode = 'queued'
          AND runs.status = 'queued'
      ) <> 1 THEN
        RAISE EXCEPTION 'expected one idempotent queued eval run';
      END IF;
      IF (
        SELECT count(*) FROM outbox_events events
        INNER JOIN eval_runs runs ON runs.id = events.aggregate_id
        INNER JOIN eval_suites suites ON suites.id = runs.suite_id
        WHERE suites.namespace_key = 'integration:component-regression'
          AND events.aggregate_type = 'eval_run'
          AND events.event_type = 'eval.run.requested'
          AND events.payload = jsonb_build_object('evalRunId', events.aggregate_id)
      ) <> 1 THEN
        RAISE EXCEPTION 'expected one pointer-only eval outbox event';
      END IF;
      IF (
        SELECT count(*) FROM eval_trials trials
        INNER JOIN eval_runs runs ON runs.id = trials.eval_run_id
        INNER JOIN eval_suites suites ON suites.id = runs.suite_id
        WHERE suites.namespace_key = 'integration:component-regression'
          AND trials.status = 'succeeded'
      ) <> 76 THEN
        RAISE EXCEPTION 'expected 76 succeeded eval trials';
      END IF;
      IF (
        SELECT count(*) FROM eval_scores scores
        INNER JOIN eval_trials trials ON trials.id = scores.trial_id
        INNER JOIN eval_runs runs ON runs.id = trials.eval_run_id
        INNER JOIN eval_suites suites ON suites.id = runs.suite_id
        WHERE suites.namespace_key = 'integration:component-regression'
          AND scores.status = 'succeeded'
          AND scores.passed = true
      ) <> 76 THEN
        RAISE EXCEPTION 'expected 76 passing eval scores';
      END IF;
    END $$;`,
  ])
} finally {
  let stopError
  if (dataDirectory && (await isPostgresRunning(dataDirectory))) {
    try {
      await run('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'])
    } catch (error) {
      stopError = error
      process.stderr.write(`${error.message}\n`)
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
