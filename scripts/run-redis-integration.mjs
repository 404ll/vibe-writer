import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const testId = randomBytes(16).toString('hex')
const containerName = `vibe-writer-redis-${testId}`
const image = 'redis:7.4-alpine'

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
    })
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

let started = false
try {
  await run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--label',
      `vibe-writer.integration=${testId}`,
      '--publish',
      '127.0.0.1::6379',
      image,
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { capture: true },
  )
  started = true
  await waitForRedis()
  const portLine = await run('docker', ['port', containerName, '6379/tcp'], {
    capture: true,
  })
  const match = portLine.match(/127\.0\.0\.1:(\d+)$/)
  if (!match) throw new Error(`Unexpected Redis port mapping: ${portLine}`)
  await run(
    'pnpm',
    ['--filter', '@vibe-writer/worker', 'test:redis'],
    {
      env: {
        TEST_REDIS_URL: `redis://127.0.0.1:${match[1]}`,
        VIBE_WRITER_REDIS_TEST_ID: testId,
      },
    },
  )
} finally {
  if (started && /^vibe-writer-redis-[0-9a-f]{32}$/.test(containerName)) {
    try {
      await run('docker', ['stop', '--time', '5', containerName], { capture: true })
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
    }
  }
}
