import type {
  TextModelRequest,
  TextModelResponse,
  ToolModelRequest,
  ToolModelResponse,
} from '@vibe-writer/model-runtime'
import type { WorkflowSearchProgress } from '@vibe-writer/workflow-runtime'
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
    const searchProgress: WorkflowSearchProgress[] = []
    const onSearchProgress = async (progress: WorkflowSearchProgress) => {
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
      onSearchProgress,
    })

    expect(result).toMatchObject({ status: 'ready', content: '带资料的正文' })
    expect(searchProgress).toEqual([
      { phase: 'started', query: '可靠事件流', index: 1 },
      {
        phase: 'finished',
        query: '可靠事件流',
        index: 1,
        preview: '这是检索摘要',
        chars: 6,
      },
    ])
  })
})
