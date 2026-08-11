import type {
  TextModelRequest,
  TextModelResponse,
  ToolModelRequest,
  ToolModelResponse,
} from '@vibe-writer/model-runtime'
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
})
