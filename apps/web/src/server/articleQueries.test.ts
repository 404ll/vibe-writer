import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  enabled: vi.fn(),
  authorize: vi.fn(),
  getArticle: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock('./durableDatabase', () => ({
  durableArticleReadEnabled: durable.enabled,
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    articles: { getArticle: durable.getArticle },
  }),
}))

describe('server article source cutover', () => {
  beforeEach(() => {
    durable.enabled.mockReset()
    durable.getArticle.mockReset()
    durable.authorize.mockReset()
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role: 'viewer',
        authorization: 'verified-membership',
      },
    })
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads PostgreSQL directly only when the independent article flag is enabled', async () => {
    durable.enabled.mockReturnValue(true)
    durable.getArticle.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      jobId: '22222222-2222-4222-8222-222222222222',
      topic: 'Durable article',
      content: '# Durable',
      wordCount: 8,
      revision: 0,
      createdAt: new Date('2026-08-07T00:00:00.000Z'),
    })
    const { getArticleForPage } = await import('./articleQueries')

    await expect(getArticleForPage('11111111-1111-4111-8111-111111111111'))
      .resolves.toMatchObject({ content: '# Durable', revision: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves the Python/FastAPI source by default', async () => {
    durable.enabled.mockReturnValue(false)
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      id: 'article-1',
      job_id: 'job-1',
      topic: 'Python article',
      content: '# Python',
      word_count: 7,
      created_at: '2026-08-07T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { getArticleForPage } = await import('./articleQueries')

    await expect(getArticleForPage('article-1')).resolves.toMatchObject({
      content: '# Python',
    })
    expect(durable.getArticle).not.toHaveBeenCalled()
  })
})
