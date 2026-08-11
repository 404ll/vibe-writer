import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  authorize: vi.fn(),
  getArticle: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock('./durableDatabase', () => ({
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    articles: { getArticle: durable.getArticle },
  }),
}))

describe('server article source cutover', () => {
  beforeEach(() => {
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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads articles from the only PostgreSQL product source', async () => {
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
  })

  it('returns null when the request is not authorized', async () => {
    durable.authorize.mockResolvedValue({ status: 'unauthenticated' })
    const { getArticleForPage } = await import('./articleQueries')

    await expect(getArticleForPage('article-1')).resolves.toBeNull()
    expect(durable.getArticle).not.toHaveBeenCalled()
  })
})
