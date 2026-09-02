import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WritingWorkspace } from './WritingWorkspace'

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(),
  getArticles: vi.fn(),
  useJobStream: vi.fn<(
    jobId: string | null,
    onEvent: (type: string, data: Record<string, unknown>) => void,
  ) => void>(),
  writeActiveJobId: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/hooks/useJobStream', () => ({
  useJobStream: mocks.useJobStream,
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

  it('shows persisted planning events in the realtime activity log', async () => {
    render(<WritingWorkspace />)

    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: '前端为什么总是死' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))

    await waitFor(() => {
      expect(mocks.useJobStream).toHaveBeenCalledWith('job-created-1', expect.any(Function))
    })
    const streamCall = mocks.useJobStream.mock.calls.find(([jobId]) => jobId === 'job-created-1')
    const onEvent = streamCall?.[1]
    expect(onEvent).toBeTypeOf('function')

    act(() => onEvent?.('stage_update', { stage: 'plan', _seq: 0 }))
    expect(screen.getByRole('log')).toHaveTextContent('正在规划文章大纲…')

    act(() => onEvent?.('outline_ready', { outline: ['第一章'], _seq: 1 }))
    expect(screen.getByRole('log')).toHaveTextContent('大纲已生成，等待确认')
  })
})
