import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WritingWorkspace } from './WritingWorkspace'

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(),
  getArticles: vi.fn(),
  writeActiveJobId: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/hooks/useJobStream', () => ({
  useJobStream: vi.fn(),
}))

vi.mock('@/lib/storage/jobStorage', () => ({
  useActiveJobId: () => null,
  clearActiveJobId: vi.fn(),
  writeActiveJobId: mocks.writeActiveJobId,
}))

vi.mock('@/lib/api/jobs', () => ({
  createJob: mocks.createJob,
}))

vi.mock('@/lib/api/articles', () => ({
  getArticles: mocks.getArticles,
}))

describe('WritingWorkspace job create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getArticles.mockResolvedValue([])
    mocks.createJob.mockResolvedValue({ job_id: 'job-created-1' })
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('creates a job through the shared client instead of a raw fetch', async () => {
    render(<WritingWorkspace />)

    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: 'RAG 检索增强生成' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))

    await waitFor(() => {
      expect(mocks.createJob).toHaveBeenCalledWith({
        topic: 'RAG 检索增强生成',
        intervention: { on_outline: true },
        style: '',
        target_words: null,
      })
    })
    expect(mocks.writeActiveJobId).toHaveBeenCalledWith('job-created-1')
  })
})
