import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WritingWorkspace } from './WritingWorkspace'

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(),
  getArticles: vi.fn(),
  useJobStream: vi.fn<(
    jobId: string | null,
    onEvent: (type: string, data: Record<string, unknown>) => void,
  ) => void>(),
  writeActiveJobId: vi.fn(),
  streamCallback: null as null | ((type: string, data: Record<string, unknown>) => void),
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
    mocks.streamCallback = null
    mocks.useJobStream.mockImplementation((_jobId, callback) => {
      mocks.streamCallback = callback
    })
    mocks.getArticles.mockResolvedValue([])
    mocks.createJob.mockResolvedValue({ job_id: 'job-created-1' })
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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

  it('keeps the input available and explains when job creation fails', async () => {
    mocks.createJob.mockRejectedValueOnce(new Error('network unavailable'))
    render(<WritingWorkspace />)

    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: '失败重试' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('任务创建失败，请检查后重试。')
    expect(screen.getByRole('button', { name: '开始写作' })).toBeEnabled()
  })

  it('keeps outline review visible when the reply API rejects the submission', async () => {
    const replyFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 })
    vi.stubGlobal('fetch', replyFetch)
    render(<WritingWorkspace />)

    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: '大纲提交' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))
    await waitFor(() => expect(mocks.streamCallback).not.toBeNull())
    act(() => mocks.streamCallback?.('outline_ready', { outline: ['第一章'] }))

    fireEvent.click(await screen.findByRole('button', { name: '确认继续' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('提交失败，请检查后重试。')
    expect(screen.getByText('大纲确认')).toBeInTheDocument()
    expect(replyFetch).toHaveBeenCalledTimes(1)
  })

  it('does not let a slow old reply hide a newer outline review event', async () => {
    let resolveReply!: (value: { ok: boolean; status: number }) => void
    const replyFetch = vi.fn(() => new Promise<{ ok: boolean; status: number }>((resolve) => {
      resolveReply = resolve
    }))
    vi.stubGlobal('fetch', replyFetch)
    render(<WritingWorkspace />)

    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: '大纲竞态' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))
    await waitFor(() => expect(mocks.streamCallback).not.toBeNull())
    act(() => mocks.streamCallback?.('outline_ready', { outline: ['旧章节'] }))
    fireEvent.click(await screen.findByRole('button', { name: '确认继续' }))

    act(() => mocks.streamCallback?.('outline_ready', { outline: ['新章节'] }))
    await act(async () => resolveReply({ ok: true, status: 200 }))

    expect(screen.getByText('大纲确认')).toBeInTheDocument()
    expect(screen.getByDisplayValue('新章节')).toBeInTheDocument()
  })

  it('rejects an empty edited chapter before calling the reply API', async () => {
    const replyFetch = vi.fn()
    vi.stubGlobal('fetch', replyFetch)
    render(<WritingWorkspace />)

    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: '大纲校验' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))
    await waitFor(() => expect(mocks.streamCallback).not.toBeNull())
    act(() => mocks.streamCallback?.('outline_ready', { outline: ['第一章'] }))
    fireEvent.change(await screen.findByLabelText('章节 1'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认继续' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('章节标题不能为空。')
    expect(replyFetch).not.toHaveBeenCalled()
  })

  it('describes Writer–Reviewer milestones without pretending to stream hidden reasoning', async () => {
    render(<WritingWorkspace />)
    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: 'Agent 架构' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))
    await waitFor(() => expect(mocks.streamCallback).not.toBeNull())

    act(() => mocks.streamCallback?.('stage_update', { stage: 'write' }))
    expect(screen.getByText('Writer 正在创作完整文章…')).toBeInTheDocument()

    act(() => mocks.streamCallback?.('stage_update', { stage: 'review' }))
    expect(screen.getByText('文章草稿已就绪，交给独立 Reviewer…')).toBeInTheDocument()

    act(() => mocks.streamCallback?.('review_done', {
      results: [{ title: '完整文章草稿', passed: false, feedback: '需要修订' }],
    }))
    expect(screen.getByText('全文审稿未通过，Writer 将按结构化反馈修订')).toBeInTheDocument()
  })

  it('shows an explicit warning when the bounded review loop is exhausted', async () => {
    render(<WritingWorkspace />)
    fireEvent.change(screen.getByLabelText('写作主题'), { target: { value: 'Agent 架构' } })
    fireEvent.click(screen.getByRole('button', { name: '开始写作' }))
    await waitFor(() => expect(mocks.streamCallback).not.toBeNull())

    act(() => mocks.streamCallback?.('review_done', {
      results: [{
        title: '完整文章草稿',
        passed: false,
        feedback: '已达审核轮次上限：转场仍需人工检查。',
      }],
    }))
    expect(screen.getByText('审核两轮后仍有问题，将保存当前版本供人工检查')).toBeInTheDocument()
  })
})
