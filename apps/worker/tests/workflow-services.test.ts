import type {
  TextModelRequest,
  TextModelResponse,
  ToolModelRequest,
  ToolModelResponse,
} from '@vibe-writer/model-runtime'
import { buildWritingBrief, emptyWriterSession } from '@vibe-writer/agent-core'
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
    const brief = buildWritingBrief({ topic: '主题', style: '教程' })
    await expect(services.plan({ brief, signal })).resolves.toEqual(['初始章'])
    await expect(services.reviseOutline({
      brief, outline: ['初始章'], feedback: '修改', editorialDecisions: [], signal,
    })).resolves.toEqual(['修订章'])
    await expect(services.writeArticle({
      brief,
      approvedOutline: ['初始章'],
      editorialDecisions: [],
      session: emptyWriterSession(),
      reviewReport: null,
      signal,
    })).resolves.toMatchObject({ status: 'ready', draft: '正文' })
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

    const result = await createWorkflowServices(model, search).writeArticle({
      brief: buildWritingBrief({ topic: '主题' }),
      approvedOutline: ['初始章'],
      editorialDecisions: [],
      session: emptyWriterSession(),
      reviewReport: null,
      effectScope: 'article:cycle:1:attempt:1',
      onSearchProgress,
    })

    expect(result).toMatchObject({ status: 'ready', draft: '带资料的正文' })
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
