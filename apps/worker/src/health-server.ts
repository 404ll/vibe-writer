import { createServer, type Server } from 'node:http'

export type WorkerHealthPhase = 'starting' | 'ready' | 'draining' | 'stopped'

export type WorkerHealthServerOptions = {
  host: string
  port: number
}

function healthResponse(phase: WorkerHealthPhase, path: string): {
  status: number
  body: { status: string }
} {
  if (path === '/live') {
    return phase === 'stopped'
      ? { status: 503, body: { status: 'stopped' } }
      : { status: 200, body: { status: 'live' } }
  }
  if (path === '/ready') {
    return phase === 'ready'
      ? { status: 200, body: { status: 'ready' } }
      : { status: 503, body: { status: 'not_ready' } }
  }
  return { status: 404, body: { status: 'not_found' } }
}

export class WorkerHealthServer {
  private phase: WorkerHealthPhase = 'starting'
  private server: Server | null = null

  constructor(private readonly options: WorkerHealthServerOptions) {}

  async start(): Promise<void> {
    if (this.server) throw new Error('Worker health server already started')
    this.phase = 'starting'
    this.server = createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          allow: 'GET',
        })
        response.end(JSON.stringify({ status: 'method_not_allowed' }))
        return
      }
      const result = healthResponse(this.phase, request.url ?? '')
      response.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify(result.body))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(this.options.port, this.options.host, resolve)
      })
    } catch (error) {
      this.server = null
      this.phase = 'stopped'
      throw error
    }
  }

  markReady(): void {
    if (this.phase !== 'starting') {
      throw new Error(`Worker health cannot become ready from ${this.phase}`)
    }
    this.phase = 'ready'
  }

  markDraining(): void {
    if (this.phase !== 'stopped') this.phase = 'draining'
  }

  async close(): Promise<void> {
    if (!this.server) {
      this.phase = 'stopped'
      return
    }
    const server = this.server
    this.server = null
    this.phase = 'stopped'
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}
