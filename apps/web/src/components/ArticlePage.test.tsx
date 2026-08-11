import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ArticlePage } from './ArticlePage'

const mocks = vi.hoisted(() => ({
  patchArticle: vi.fn(),
  getVersions: vi.fn(),
  getVersion: vi.fn(),
  restoreVersion: vi.fn(),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

vi.mock('../api', () => ({
  patchArticle: mocks.patchArticle,
  getVersions: mocks.getVersions,
  getVersion: mocks.getVersion,
  restoreVersion: mocks.restoreVersion,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.patchArticle.mockResolvedValue(null)
  class IntersectionObserverMock {
    observe = vi.fn()
    disconnect = vi.fn()
  }
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
})

it('edits and saves the server-provided article in the client component', async () => {
  render(
    <ArticlePage
      articleId="article-1"
      initialArticle={{
        id: 'article-1',
        job_id: 'job-1',
        topic: '测试文章',
        content: '# 原内容',
        word_count: 4,
        created_at: '2026-08-07T00:00:00Z',
        revision: 3,
      }}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '✎ 编辑' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '# 新内容' } })
  fireEvent.click(screen.getByRole('button', { name: '✓ 保存' }))

  await waitFor(() => {
    expect(mocks.patchArticle).toHaveBeenCalledWith('article-1', '# 新内容', 3)
  })
  expect(screen.getByRole('heading', { name: '新内容' })).toBeInTheDocument()
})
