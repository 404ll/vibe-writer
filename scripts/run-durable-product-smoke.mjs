import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const topic = `Durable product smoke ${randomUUID()}`

function fakeProvider() {
  let requestCount = 0
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = typeof body.system === 'string' ? body.system : ''
    const tools = Array.isArray(body.tools) ? body.tools : []
    requestCount += 1

    let text
    if (tools.length > 0) {
      text = '这是通过Next durable API与TypeScript Worker生成的验证正文。'
    } else if (system.includes('技术内容策划')) {
      text = JSON.stringify({
        opinions: ['说明本地durable切流已经连通'],
        search_queries: ['durable local cutover'],
      })
    } else if (system.includes('审阅完整文章每一章')) {
      text = JSON.stringify({
        results: [{ title: '本地切流验证', passed: true, feedback: '' }],
      })
    } else if (system.includes('审阅给定章节')) {
      text = JSON.stringify({ passed: true, feedback: '' })
    } else {
      text = '1. 初始章节'
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      id: `durable-smoke-${requestCount}`,
      model: 'durable-smoke-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }))
  })
  return {
    server,
    requestCount: () => requestCount,
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Fake provider did not bind a local port'))
        return
      }
      resolve(address.port)
    })
  })
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => error ? reject(error) : resolve())
  })
}

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function request(path, init, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    cache: 'no-store',
    ...init,
  })
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`)
  }
  return response
}

async function eventually(operation, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await operation()
      if (result !== undefined) return result
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw lastError ?? new Error('Durable product smoke timed out')
}

const provider = fakeProvider()
const providerPort = await listen(provider.server)
let output = ''
const durable = spawn('node', ['scripts/run-durable-dev.mjs'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    DURABLE_DEV_ENV_FILE: '',
    ANTHROPIC_API_KEY: 'durable-smoke-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`,
    MODEL_ID: 'durable-smoke-model',
    TAVILY_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
durable.stdout.on('data', (chunk) => { output += chunk })
durable.stderr.on('data', (chunk) => { output += chunk })

try {
  await eventually(async () => {
    const response = await fetch('http://127.0.0.1:3000/api/durable/health/ready')
    if (response.ok) return true
  })
  await eventually(async () => {
    const response = await fetch('http://127.0.0.1:3001/ready')
    if (response.ok) return true
  })

  const createResponse = await request('/api/durable/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `durable-product-smoke-${randomUUID()}`,
    },
    body: JSON.stringify({
      topic,
      intervention: { on_outline: true },
      style: '',
      target_words: 200,
    }),
  })
  const { job_id: jobId } = await createResponse.json()

  await eventually(async () => {
    const response = await request(`/api/durable/jobs/${jobId}/events`)
    const body = await response.json()
    return body.events.some((event) => event.event === 'outline_ready') ? true : undefined
  })
  await request(`/api/durable/jobs/${jobId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '请修改大纲' }),
  })
  await eventually(async () => {
    const response = await request(`/api/durable/jobs/${jobId}/events`)
    const body = await response.json()
    return body.events.filter((event) => event.event === 'outline_ready').length === 2
      ? true
      : undefined
  })
  await request(`/api/durable/jobs/${jobId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '确认', outline: ['本地切流验证'] }),
  })

  const doneEvent = await eventually(async () => {
    const response = await request(`/api/durable/jobs/${jobId}/events`)
    const body = await response.json()
    const error = body.events.find((event) => event.event === 'error')
    if (error) throw new Error(`Durable job failed: ${error.data.message}`)
    return body.events.find((event) => event.event === 'done')
  })
  const articleId = doneEvent.data.article_id

  const articleResponse = await request(`/api/durable/articles/${articleId}`)
  const article = await articleResponse.json()
  if (article.job_id !== jobId || article.revision !== 0) {
    throw new Error(`Unexpected terminal article: ${JSON.stringify(article)}`)
  }
  const articlePage = await request(`/articles/${articleId}`)
  if (!(await articlePage.text()).includes(topic)) {
    throw new Error('Server-rendered article did not read from durable PostgreSQL')
  }

  const editedContent = `${article.content}\n\n本地编辑验证。`
  const patchResponse = await request(`/api/durable/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: editedContent, expected_revision: article.revision }),
  })
  const patched = await patchResponse.json()
  if (patched.article?.revision !== 1 || patched.article?.content !== editedContent) {
    throw new Error(`Unexpected patched article: ${JSON.stringify(patched)}`)
  }

  const versionsResponse = await request(`/api/durable/articles/${articleId}/versions`)
  const { versions } = await versionsResponse.json()
  const previous = versions[0]
  if (!previous?.id) throw new Error('Article edit did not create a historical version')
  const restoreResponse = await request(
    `/api/durable/articles/${articleId}/versions/${previous.id}/restore`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: 1 }),
    },
  )
  const restored = await restoreResponse.json()
  if (restored.article?.revision !== 2 || restored.article?.content !== article.content) {
    throw new Error(`Unexpected restored article: ${JSON.stringify(restored)}`)
  }

  process.stdout.write(JSON.stringify({
    status: 'passed',
    jobId,
    articleId,
    providerRequestCount: provider.requestCount(),
    eventTypes: ['outline_ready', 'outline_ready', 'done'],
    articleRevisions: [0, 1, 2],
  }) + '\n')
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n${output}`)
  process.exitCode = 1
} finally {
  await stop(durable)
  await closeServer(provider.server)
}
