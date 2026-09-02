import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SSEEventType } from '@/types'
import { WritingWorkspace } from './WritingWorkspace'

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(),
  getArticles: vi.fn(),
  writeActiveJobId: vi.fn(),
  streamEvent: null as null | ((type: SSEEventType, data: Record<string, unknown>) => void),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/hooks/useJobStream', () => ({
  useJobStream: vi.fn((
    _jobId: string | null,
    onEvent: (type: SSEEventType, data: Record<string, unknown>) => void,
  ) => {
    mocks.streamEvent = onEvent
  }),
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

  it('shows durable web extraction progress without rendering page content', async () => {
    render(<WritingWorkspace />)
    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: '自由研究' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))
    await waitFor(() => expect(mocks.streamEvent).not.toBeNull())

    act(() => {
      mocks.streamEvent?.('extracting', {
        title: '研究章节', url: 'https://example.com/source', index: 1,
      })
      mocks.streamEvent?.('extract_done', {
        title: '研究章节', url: 'https://example.com/source', index: 1,
        source_title: '公开来源', chars: 1200, status: 'ready',
      })
    })

    expect(screen.getByText('正在读取网页：研究章节「https://example.com/source」')).toBeInTheDocument()
    expect(screen.getByText('网页读取完成：公开来源（1200 字）')).toBeInTheDocument()
    expect(screen.queryByText(/网页中的完整正文/u)).not.toBeInTheDocument()
  })
})
