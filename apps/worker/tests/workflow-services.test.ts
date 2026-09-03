import type {
  TextModelRequest,
  TextModelResponse,
  ToolModelRequest,
  ToolModelResponse,
} from '@vibe-writer/model-runtime'
import type { WorkflowResearchProgress } from '@vibe-writer/workflow-runtime'
import { describe, expect, it, vi } from 'vitest'
import { createWorkflowServices } from '../src/workflow-services'

class Model {
  text = vi.fn(async (request: TextModelRequest): Promise<TextModelResponse> => ({
    text: request.operation === 'planner.revise' ? '1. 修订章' : '1. 初始章',
    provider: 'scripted', model: 'scripted', finishReason: 'stop',
  }))
  tool = vi.fn(async (_request: ToolModelRequest): Promise<ToolModelResponse> => ({
    blocks: [{ type: 'text', text: '正文' }], stopReason: 'end_turn',
    provider: 'scripted', model: 'scripted',
  }))
  generate = this.text
  generateWithTools = this.tool
}

describe('production workflow service composition', () => {
  it('wires plan/revise and carries signal/style into provider-facing services', async () => {
    const model = new Model()
    const services = createWorkflowServices(model)
    const signal = new AbortController().signal
    await expect(services.plan({ topic: '主题', signal })).resolves.toEqual(['初始章'])
    await expect(services.reviseOutline({
      topic: '主题', outline: ['初始章'], feedback: '修改', signal,
    })).resolves.toEqual(['修订章'])
    await expect(services.writeChapter({
      topic: '主题', outline: '1. 初始章', chapterTitle: '初始章',
      coveragePoints: [], reviewFeedback: '', budgetUsage: { totalCalls: 0, callsByTool: {} },
      style: '教程', signal,
    })).resolves.toMatchObject({ status: 'ready', content: '正文' })
    expect(model.text).toHaveBeenCalledWith(expect.objectContaining({ signal }))
    expect(model.tool).toHaveBeenCalledWith(expect.objectContaining({
      signal, system: expect.stringContaining('手把手教学'),
    }))
  })

  it('reports the real Writer search query and durable completion preview', async () => {
    const model = new Model()
    model.tool
      .mockResolvedValueOnce({
        blocks: [
          {
            type: 'tool_call',
            id: 'search-1',
            name: 'search',
            input: { query: '可靠事件流' },
          },
        ],
        stopReason: 'tool_use',
        provider: 'scripted',
        model: 'scripted',
      })
      .mockResolvedValueOnce({
        blocks: [{ type: 'text', text: '带资料的正文' }],
        stopReason: 'end_turn',
        provider: 'scripted',
        model: 'scripted',
      })
    model.text.mockResolvedValueOnce({
      text: '这是检索摘要',
      provider: 'scripted',
      model: 'scripted',
      finishReason: 'stop',
    })
    const search = {
      search: vi.fn(async () => ({
        provider: 'scripted',
        documents: [
          {
            title: '资料',
            url: 'https://example.com/source',
            content: '可验证内容',
          },
        ],
      })),
    }
    const searchProgress: WorkflowResearchProgress[] = []
    const onResearchProgress = async (progress: WorkflowResearchProgress) => {
      searchProgress.push(progress)
    }

    const result = await createWorkflowServices(model, search).writeChapter({
      topic: '主题',
      outline: '1. 初始章',
      chapterTitle: '初始章',
      coveragePoints: [],
      reviewFeedback: '',
      budgetUsage: { totalCalls: 0, callsByTool: {} },
      effectScope: 'chapter:0:write:attempt:1',
      onResearchProgress,
    })

    expect(result).toMatchObject({ status: 'ready', content: '带资料的正文' })
    expect(searchProgress).toEqual([
      { tool: 'search', phase: 'started', query: '可靠事件流', index: 1 },
      {
        tool: 'search',
        phase: 'finished',
        query: '可靠事件流',
        index: 1,
        preview: '这是检索摘要',
        chars: 6,
      },
    ])
  })

  it('reports bounded extraction progress without putting page content in events', async () => {
    const model = new Model()
    model.tool
      .mockResolvedValueOnce({
        blocks: [{
          type: 'tool_call',
          id: 'extract-1',
          name: 'extract_webpage',
          input: { url: 'https://example.com/source' },
        }],
        stopReason: 'tool_use', provider: 'scripted', model: 'scripted',
      })
      .mockResolvedValueOnce({
        blocks: [{ type: 'text', text: '核实后的正文' }],
        stopReason: 'end_turn', provider: 'scripted', model: 'scripted',
      })
    const extractor = {
      extract: vi.fn(async ({ url }: { url: string }) => ({
        provider: 'readability', url, finalUrl: url, title: '来源标题',
        contentType: 'text/html', content: '不应写进进度事件的完整正文', truncated: false,
      })),
    }
    const progress: WorkflowResearchProgress[] = []
    const result = await createWorkflowServices(model, undefined, extractor).writeChapter({
      topic: '主题', outline: '1. 初始章', chapterTitle: '初始章',
      coveragePoints: [], reviewFeedback: '', budgetUsage: { totalCalls: 0, callsByTool: {} },
      onResearchProgress: async (event) => { progress.push(event) },
    })

    expect(result).toMatchObject({ status: 'ready', content: '核实后的正文' })
    expect(progress).toEqual([
      {
        tool: 'extract_webpage', phase: 'started',
        url: 'https://example.com/source', index: 1,
      },
      {
        tool: 'extract_webpage', phase: 'finished',
        url: 'https://example.com/source', index: 1,
        sourceTitle: '来源标题', chars: 13, status: 'ready',
      },
    ])
    expect(JSON.stringify(progress)).not.toContain('完整正文')
  })
})
