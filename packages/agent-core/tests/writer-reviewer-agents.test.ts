import type {
  TextModelRequest,
  ToolModelRequest,
  ToolModelResponse,
} from '@vibe-writer/model-runtime'
import { describe, expect, it, vi } from 'vitest'
import { PlannerService } from '../src/planner'
import { ReviewerAgentService, inspectDraftDeterministically } from '../src/reviewer-agent'
import { WriterAgentService, articleDraftBudget } from '../src/writer-agent'
import {
  REVIEW_REPORT_VERSION,
  WRITER_SESSION_VERSION,
  buildWritingBrief,
  emptySourceNotebook,
  emptyWriterSession,
  type ReviewReport,
} from '../src/writing-artifacts'

const report: ReviewReport = {
  version: REVIEW_REPORT_VERSION,
  verdict: 'needs_revision',
  summary: '转场不足。',
  globalIssues: ['全文缺少同一条主线。'],
  localIssues: [{
    section: '第二章', issue: '重复开场。', suggestion: '承接第一章结论。',
  }],
}

describe('Writer–Reviewer agent boundaries', () => {
  it('puts custom style into Planner input instead of waiting until prose generation', async () => {
    const generate = vi.fn(async () => ({
      text: '1. 开场\n2. 收束', provider: 'scripted', model: 'scripted', finishReason: 'stop' as const,
    }))
    const planner = new PlannerService({ generate })
    await planner.plan({ brief: buildWritingBrief({ topic: '缓存', style: '幽默风趣' }) })

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'planner.plan',
      user: expect.stringContaining('幽默风趣'),
    }))
  })

  it('records bounded search evidence for the fresh Reviewer notebook', async () => {
    const generateWithTools = vi
      .fn<(request: ToolModelRequest) => Promise<ToolModelResponse>>()
      .mockResolvedValueOnce({
        blocks: [{ type: 'tool_call', id: 'search-1', name: 'search', input: { query: '缓存案例' } }],
        stopReason: 'tool_use', provider: 'scripted', model: 'scripted',
      })
      .mockResolvedValueOnce({
        blocks: [{ type: 'text', text: '# 主题\n\n## 第一章\n正文' }],
        stopReason: 'end_turn', provider: 'scripted', model: 'scripted',
      })
    const writer = new WriterAgentService({ generateWithTools }, {
      research: async () => ({
        status: 'ready',
        query: '缓存案例',
        summary: '案例显示缓存失效需要版本化 key。',
        sources: [{
          title: '缓存文档', url: 'https://example.com/cache',
          content: '版本化缓存键案例。', score: 0.9,
        }],
        request: {
          query: '缓存案例', topic: 'general', searchDepth: 'advanced', maxResults: 5,
          startDate: '2026-01-01', endDate: '2026-09-03',
        },
        provider: 'scripted-search',
      }),
    })
    const result = await writer.write({
      brief: buildWritingBrief({ topic: '主题' }),
      approvedOutline: ['第一章'],
      editorialDecisions: [],
      session: emptyWriterSession(),
    })
    expect(result.sources).toEqual([
      expect.objectContaining({
        url: 'https://example.com/cache',
        evidence: expect.stringContaining('缓存失效需要版本化 key'),
      }),
    ])
  })

  it('keeps normal Writer messages across a structured review revision', async () => {
    const generateWithTools = vi
      .fn<(request: ToolModelRequest) => Promise<ToolModelResponse>>()
      .mockResolvedValueOnce({
        blocks: [{ type: 'text', text: '# 主题\n\n## 第一章\n初稿' }],
        stopReason: 'end_turn', provider: 'scripted', model: 'scripted',
      })
      .mockResolvedValueOnce({
        blocks: [{ type: 'text', text: '# 主题\n\n## 第一章\n修订稿' }],
        stopReason: 'end_turn', provider: 'scripted', model: 'scripted',
      })
    const writer = new WriterAgentService({ generateWithTools })
    const brief = buildWritingBrief({ topic: '主题', style: '教程' })
    const first = await writer.write({
      brief, approvedOutline: ['第一章'], editorialDecisions: [], session: emptyWriterSession(),
    })
    if (first.status !== 'ready') throw new Error('Expected first draft')
    await writer.write({
      brief,
      approvedOutline: ['第一章'],
      editorialDecisions: [],
      session: first.session,
      reviewReport: report,
    })

    const secondRequest = generateWithTools.mock.calls[1]?.[0]
    expect(secondRequest?.messages.slice(0, first.session.messages.length)).toEqual(first.session.messages)
    expect(secondRequest?.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'user',
      content: [expect.objectContaining({ text: expect.stringContaining('转场不足') })],
    }))
  })

  it('gives Reviewer only explicit artifacts and returns a strict ReviewReport', async () => {
    const generate = vi.fn(async (request: TextModelRequest) => ({
      text: JSON.stringify({
        version: REVIEW_REPORT_VERSION,
        verdict: 'approved',
        summary: '通过。',
        globalIssues: [],
        localIssues: [],
      }),
      provider: 'scripted', model: 'scripted', finishReason: 'stop' as const,
      request,
    }))
    const reviewer = new ReviewerAgentService({ generate })
    const result = await reviewer.review({
      brief: buildWritingBrief({ topic: '主题' }),
      approvedOutline: ['第一章'],
      editorialDecisions: [],
      sources: emptySourceNotebook(),
      draft: '# 主题\n\n## 第一章\n完整正文。',
    })
    expect(result).toMatchObject({ status: 'ready', report: { verdict: 'approved' } })
    const request = generate.mock.calls[0]?.[0]
    expect(request?.user).toContain('当前完整草稿')
    expect(request?.user).not.toContain('writer-private-history')
  })

  it('checks structure and budget deterministically before model review', () => {
    const deterministic = inspectDraftDeterministically({
      brief: buildWritingBrief({ topic: '主题', targetWords: 10 }),
      approvedOutline: ['第一章', '第二章'],
      editorialDecisions: [],
      sources: emptySourceNotebook(),
      draft: '# 主题\n\n## 第一章\n这是一段明显超过目标篇幅而且缺少第二章的正文。',
    })
    expect(deterministic).toMatchObject({
      verdict: 'needs_revision',
      localIssues: [expect.objectContaining({ section: '第二章' })],
    })
    expect(deterministic?.globalIssues[0]).toContain('超过')
    expect(articleDraftBudget(1_000)).toBe(2_200)
  })

  it('accepts a provider-neutral max_tokens continuation transcript', async () => {
    const generateWithTools = vi.fn(async () => ({
      blocks: [{ type: 'text' as const, text: '\n\n## 第二章\n结尾' }],
      stopReason: 'end_turn' as const,
      provider: 'scripted',
      model: 'scripted',
    }))
    const writer = new WriterAgentService({ generateWithTools })
    const result = await writer.write({
      brief: buildWritingBrief({ topic: '主题' }),
      approvedOutline: ['第一章', '第二章'],
      editorialDecisions: [],
      session: {
        version: WRITER_SESSION_VERSION,
        messages: [{
          role: 'assistant', content: [{ type: 'text', text: '# 主题\n\n## 第一章\n前半段' }],
        }],
        budgetUsage: { totalCalls: 0, callsByTool: {} },
      },
      continuationPrefix: '# 主题\n\n## 第一章\n前半段',
    })
    expect(result).toMatchObject({
      status: 'ready', draft: '# 主题\n\n## 第一章\n前半段\n\n## 第二章\n结尾',
    })
  })

  it('rejects a tool-call id reused from the checkpointed Writer transcript', async () => {
    const generateWithTools = vi.fn(async () => ({
      blocks: [{
        type: 'tool_call' as const,
        id: 'search-1',
        name: 'generate_diagram',
        input: { diagram_type: 'flowchart', mermaid_code: 'A --> B' },
      }],
      stopReason: 'tool_use' as const,
      provider: 'scripted',
      model: 'scripted',
    }))
    const writer = new WriterAgentService({ generateWithTools })
    const result = await writer.write({
      brief: buildWritingBrief({ topic: '主题' }),
      approvedOutline: ['第一章'],
      editorialDecisions: [],
      session: {
        version: WRITER_SESSION_VERSION,
        messages: [
          { role: 'assistant', content: [{
            type: 'tool_call', id: 'search-1', name: 'generate_diagram',
            input: { diagram_type: 'flowchart', mermaid_code: 'A --> B' },
          }] },
          { role: 'user', content: [{
            type: 'tool_result', toolCallId: 'search-1', content: 'done', isError: false,
          }] },
        ],
        budgetUsage: { totalCalls: 1, callsByTool: { generate_diagram: 1 } },
      },
    })
    expect(result).toMatchObject({ status: 'inconclusive', reason: 'invalid_model_response' })
  })

  it('does not checkpoint an unpaired tool call returned with max_tokens', async () => {
    const generateWithTools = vi.fn(async () => ({
      blocks: [
        { type: 'text' as const, text: '# 半篇草稿' },
        {
          type: 'tool_call' as const,
          id: 'dangling-search',
          name: 'generate_diagram',
          input: { diagram_type: 'flowchart', mermaid_code: 'A --> B' },
        },
      ],
      stopReason: 'max_tokens' as const,
      provider: 'scripted',
      model: 'scripted',
    }))
    const result = await new WriterAgentService({ generateWithTools }).write({
      brief: buildWritingBrief({ topic: '主题' }),
      approvedOutline: ['第一章'],
      editorialDecisions: [],
      session: emptyWriterSession(),
    })
    expect(result).toMatchObject({
      status: 'inconclusive',
      reason: 'invalid_model_response',
      partialDraft: '',
    })
    expect(result.session.messages).toEqual([
      expect.objectContaining({ role: 'user' }),
    ])
  })

  it.each([
    ['end_turn', [], 'empty_final_text'],
    ['max_tokens', [], 'max_tokens'],
    ['end_turn', [{ type: 'text' as const, text: '   ' }], 'empty_final_text'],
  ] as const)('does not checkpoint an empty assistant response for %s', async (stopReason, blocks, reason) => {
    const generateWithTools = vi.fn(async () => ({
      blocks: [...blocks],
      stopReason,
      provider: 'scripted',
      model: 'scripted',
    }))
    const result = await new WriterAgentService({ generateWithTools }).write({
      brief: buildWritingBrief({ topic: '主题' }),
      approvedOutline: ['第一章'],
      editorialDecisions: [],
      session: emptyWriterSession(),
    })

    expect(result).toMatchObject({ status: 'inconclusive', reason })
    expect(result.session.messages).toEqual([
      expect.objectContaining({ role: 'user' }),
    ])
  })
})
