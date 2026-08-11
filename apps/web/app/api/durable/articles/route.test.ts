import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  enabled: vi.fn(),
  authorize: vi.fn(),
  listArticles: vi.fn(),
  getArticle: vi.fn(),
  patchArticle: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  restoreVersion: vi.fn(),
}))

vi.mock('../../../../src/server/durableDatabase', () => ({
  durableApiEnabled: durable.enabled,
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    articles: {
      listArticles: durable.listArticles,
      getArticle: durable.getArticle,
      patchArticle: durable.patchArticle,
      listVersions: durable.listVersions,
      getVersion: durable.getVersion,
      restoreVersion: durable.restoreVersion,
    },
  }),
}))

import { GET as listArticles } from './route'
import { GET as getArticle, PATCH as patchArticle } from './[articleId]/route'
import { POST as restoreVersion } from './[articleId]/versions/[versionId]/restore/route'

const articleId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const article = {
  id: articleId,
  jobId,
  sourceRunId: '33333333-3333-4333-8333-333333333333',
  exportIdempotencyKey: 'article-test',
  topic: 'Durable article',
  content: '# Original',
  contentFingerprint: `sha256:${'a'.repeat(64)}`,
  wordCount: 8,
  revision: 0,
  graphVersion: 'graph-v1',
  promptVersion: 'prompt-v1',
  codeRevision: 'code-v1',
  createdAt: new Date('2026-08-07T00:00:00.000Z'),
  updatedAt: new Date('2026-08-07T00:00:00.000Z'),
}

beforeEach(() => {
  for (const mock of Object.values(durable)) mock.mockReset()
  durable.authorize.mockResolvedValue({
    status: 'authorized',
    scope: {
      principalId: '44444444-4444-4444-8444-444444444444',
      workspaceId: '55555555-5555-4555-8555-555555555555',
      role: 'editor',
      authorization: 'verified-membership',
    },
  })
})

describe('durable article routes', () => {
  it('keeps the article read model fail-closed with the rest of the durable API', async () => {
    durable.enabled.mockReturnValue(false)
    const response = await listArticles(
      new Request('http://localhost/api/durable/articles'),
    )
    expect(response.status).toBe(503)
    expect(durable.listArticles).not.toHaveBeenCalled()
  })

  it('projects PostgreSQL rows into the existing article wire shape plus revision', async () => {
    durable.enabled.mockReturnValue(true)
    durable.listArticles.mockResolvedValue([article])
    durable.getArticle.mockResolvedValue(article)

    const listResponse = await listArticles(
      new Request('http://localhost/api/durable/articles'),
    )
    await expect(listResponse.json()).resolves.toEqual([
      {
        id: articleId,
        job_id: jobId,
        topic: 'Durable article',
        word_count: 8,
        created_at: '2026-08-07T00:00:00.000Z',
        revision: 0,
      },
    ])
    const detailResponse = await getArticle(
      new Request(`http://localhost/api/durable/articles/${articleId}`),
      { params: Promise.resolve({ articleId }) },
    )
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: articleId,
      content: '# Original',
      revision: 0,
    })
  })

  it('requires expected_revision and returns the winning revision on conflict', async () => {
    durable.enabled.mockReturnValue(true)
    const missing = await patchArticle(
      new Request(`http://localhost/api/durable/articles/${articleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: '# Edit' }),
      }),
      { params: Promise.resolve({ articleId }) },
    )
    expect(missing.status).toBe(428)
    expect(durable.patchArticle).not.toHaveBeenCalled()

    durable.patchArticle.mockResolvedValue({
      status: 'revision_conflict',
      currentRevision: 2,
    })
    const stale = await patchArticle(
      new Request(`http://localhost/api/durable/articles/${articleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: '# Stale', expected_revision: 1 }),
      }),
      { params: Promise.resolve({ articleId }) },
    )
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toEqual({
      detail: 'Article revision conflict.',
      current_revision: 2,
    })
  })

  it('returns the new current article after patch and restore', async () => {
    durable.enabled.mockReturnValue(true)
    durable.patchArticle.mockResolvedValue({
      status: 'updated',
      article: { ...article, content: '# Edited', revision: 1 },
      snapshot: {},
    })
    const patched = await patchArticle(
      new Request(`http://localhost/api/durable/articles/${articleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: '# Edited', expected_revision: 0 }),
      }),
      { params: Promise.resolve({ articleId }) },
    )
    expect(patched.status).toBe(200)
    await expect(patched.json()).resolves.toMatchObject({
      status: 'ok',
      article: { content: '# Edited', revision: 1 },
    })

    durable.restoreVersion.mockResolvedValue({
      status: 'updated',
      article: { ...article, revision: 2 },
      snapshot: {},
    })
    const restored = await restoreVersion(
      new Request(
        `http://localhost/api/durable/articles/${articleId}/versions/1/restore`,
        {
          method: 'POST',
          body: JSON.stringify({ expected_revision: 1 }),
        },
      ),
      { params: Promise.resolve({ articleId, versionId: '1' }) },
    )
    expect(restored.status).toBe(200)
    expect(durable.restoreVersion).toHaveBeenCalledWith({
      articleId,
      versionId: 1,
      expectedRevision: 1,
    })
  })
})
