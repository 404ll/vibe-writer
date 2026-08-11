import { readFileSync } from 'node:fs'
import { WriterComponentFixtureSchema } from '@vibe-writer/contracts/writer-component-fixtures'
import type {
  JsonObject,
  ToolAssistantBlock,
  ToolModel,
  ToolModelRequest,
  ToolModelResponse,
} from '@vibe-writer/model-runtime'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import type { ResearchResult } from '../src/research'
import {
  ToolLoopRunner,
  type RegisteredTool,
  type ToolLoopEvent,
} from '../src/tool-loop'
import {
  DIAGRAM_TOOL_DEFINITION,
  DiagramToolInputSchema,
  maxTokensForChapter,
  renderResearchToolResult,
  SEARCH_TOOL_DEFINITION,
  SearchToolInputSchema,
  WriterService,
} from '../src/writer'
import { PROMPT_VERSIONS, TOOLSET_VERSIONS } from '../src/versions'

const fixture = WriterComponentFixtureSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../contracts/fixtures/writer-tool-baseline.json', import.meta.url),
      'utf8',
    ),
  ),
)

class ScriptedToolModel implements ToolModel {
  readonly requests: ToolModelRequest[] = []

  constructor(private readonly responses: Array<ToolModelResponse | Error>) {}

  async generateWithTools(request: ToolModelRequest): Promise<ToolModelResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (!response) throw new Error(`No scripted response for ${request.operation}`)
    if (response instanceof Error) throw response
    return response
  }
}

function response(
  stopReason: ToolModelResponse['stopReason'],
  blocks: ToolAssistantBlock[],
): ToolModelResponse {
  return {
    stopReason,
    blocks,
    provider: 'scripted-tool-provider',
    model: 'fixture-tool-model',
  }
}

const SearchInputSchema = z.object({ query: z.string() })

function registeredSearch(options: {
  output?: string
  error?: Error
  maxCalls?: number
  calls?: string[]
} = {}): RegisteredTool {
  return {
    name: 'search',
    description: 'fixture search',
    inputSchema: SearchInputSchema,
    maxCalls: options.maxCalls,
    async execute(input) {
      const parsed = SearchInputSchema.parse(input)
      options.calls?.push(parsed.query)
      if (options.error) throw options.error
      return { content: options.output ?? 'fixture result' }
    },
  }
}

function fixtureResponses(testCase: (typeof fixture.tool_loop_cases)[number]): ToolModelResponse[] {
  return testCase.responses.map((item) =>
    response(
      item.stop_reason,
      item.blocks.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : {
              type: 'tool_call',
              id: block.id,
              name: block.name,
              input: block.input as JsonObject,
            },
      ),
    ),
  )
}

describe('shared Writer/tool-loop target baseline', () => {
  it.each(fixture.tool_loop_cases)('maps $id to explicit target behavior', async (testCase) => {
    const model = new ScriptedToolModel(fixtureResponses(testCase))
    const behavior = testCase.handlers.find((item) => item.name === 'search')
    const tools = behavior
      ? [
          registeredSearch({
            output: behavior.output,
            error: behavior.kind === 'error' ? new Error(behavior.output) : undefined,
          }),
        ]
      : []
    const result = await new ToolLoopRunner(model).run({
      operation: 'fixture.writer',
      promptVersion: 'fixture-prompt-v1',
      toolsetVersion: 'fixture-tools-v1',
      system: 'system',
      user: 'user',
      maxTokens: 1024,
      tools,
      maxToolRounds: testCase.max_tool_rounds,
      maxTotalCalls: 8,
    })

    expect(result.status).toBe(testCase.target.status)
    expect(result.modelRequests).toBe(testCase.target.model_requests)
    expect(result.executions.map((execution) => execution.outcome)).toEqual(
      testCase.target.execution_outcomes,
    )
    if (result.status === 'completed') {
      expect(result.text).toBe(testCase.target.text)
      expect(testCase.target.reason).toBeNull()
    } else {
      expect(result.partialText).toBe(testCase.target.text)
      expect(result.reason).toBe(testCase.target.reason)
    }
    if (testCase.id === 'handler-error-recovers') {
      expect(JSON.stringify(model.requests)).not.toContain('API secret detail')
      expect(result.executions[0]).toMatchObject({
        outcome: 'handler_error',
        content: '工具执行失败，请基于已有信息继续。',
        isError: true,
        metadata: { code: 'handler_error', retryable: false },
      })
    }
    if (testCase.id === 'unknown-tool-recovers') {
      expect(model.requests[1]?.messages.at(-1)).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'call-unknown-1',
            content: '未知工具：missing',
            isError: true,
          },
        ],
      })
    }
  })
})

describe('ToolLoopRunner safety boundaries', () => {
  it('returns every tool result in order and marks error results explicitly', async () => {
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 'known-1', name: 'search', input: { query: '一' } },
        { type: 'tool_call', id: 'unknown-1', name: 'missing', input: {} },
      ]),
      response('end_turn', [{ type: 'text', text: 'done' }]),
    ])

    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [registeredSearch()],
    })

    expect(result.status).toBe('completed')
    const resultMessage = model.requests[1]?.messages.at(-1)
    expect(resultMessage).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'known-1',
          content: 'fixture result',
          isError: false,
        },
        {
          type: 'tool_result',
          toolCallId: 'unknown-1',
          content: '未知工具：missing',
          isError: true,
        },
      ],
    })
  })

  it('enforces per-tool call budgets across calls in the same round', async () => {
    const calls: string[] = []
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
        { type: 'tool_call', id: 's2', name: 'search', input: { query: '二' } },
      ]),
      response('end_turn', [{ type: 'text', text: 'done' }]),
    ])

    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [registeredSearch({ maxCalls: 1, calls })],
    })

    expect(calls).toEqual(['一'])
    expect(result.executions.map((item) => item.outcome)).toEqual([
      'success',
      'budget_exceeded',
    ])
  })

  it('enforces the total call budget before dispatching known or unknown tools', async () => {
    const calls: string[] = []
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
        { type: 'tool_call', id: 'missing-1', name: 'missing', input: {} },
      ]),
      response('end_turn', [{ type: 'text', text: 'done' }]),
    ])

    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [registeredSearch({ calls })],
      maxTotalCalls: 1,
    })

    expect(calls).toEqual(['一'])
    expect(result.executions.map((item) => item.outcome)).toEqual([
      'success',
      'budget_exceeded',
    ])
    expect(result.executions[1]?.metadata).toEqual({ code: 'total_budget_exceeded' })
  })

  it('emits started/finished events and propagates cancellation', async () => {
    const events: ToolLoopEvent[] = []
    const cancellation = new DOMException('cancelled', 'AbortError')
    const controller = new AbortController()
    controller.abort()
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
      ]),
    ])
    const run = new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [registeredSearch({ error: cancellation })],
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
      },
    })

    await expect(run).rejects.toBe(cancellation)
    expect(events).toEqual([
      { phase: 'started', toolCallId: 's1', name: 'search', round: 1, callIndex: 1 },
    ])
  })

  it('does not misclassify a tool-internal AbortError as external cancellation', async () => {
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
      ]),
      response('end_turn', [{ type: 'text', text: 'fallback' }]),
    ])
    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [
        registeredSearch({ error: new DOMException('internal timeout', 'AbortError') }),
      ],
    })

    expect(result).toMatchObject({ status: 'completed', text: 'fallback' })
    expect(result.executions[0]).toMatchObject({ outcome: 'handler_error' })
  })

  it('emits metadata-only finished observations and ignores observer failures', async () => {
    const events: ToolLoopEvent[] = []
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
      ]),
      response('end_turn', [{ type: 'text', text: 'done' }]),
    ])
    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [registeredSearch()],
      onEvent: (event) => {
        events.push(event)
        if (event.phase === 'finished') throw new Error('trace sink unavailable')
      },
    })

    expect(result.status).toBe('completed')
    expect(events).toEqual([
      { phase: 'started', toolCallId: 's1', name: 'search', round: 1, callIndex: 1 },
      {
        phase: 'finished',
        execution: {
          toolCallId: 's1',
          name: 'search',
          round: 1,
          callIndex: 1,
          outcome: 'success',
          isError: false,
          contentLength: 'fixture result'.length,
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('fixture result')
  })

  it.each([
    [
      'duplicate call ids',
      [
        { type: 'tool_call' as const, id: 'same', name: 'search', input: { query: '一' } },
        { type: 'tool_call' as const, id: 'same', name: 'search', input: { query: '二' } },
      ],
    ],
    [
      'empty call id',
      [{ type: 'tool_call' as const, id: '', name: 'search', input: { query: '一' } }],
    ],
  ])('rejects %s as an invalid model response', async (_name, blocks) => {
    const model = new ScriptedToolModel([response('tool_use', blocks)])
    await expect(
      new ToolLoopRunner(model).run({
        operation: 'test',
        promptVersion: 'p1',
        toolsetVersion: 't1',
        system: 'system',
        user: 'user',
        maxTokens: 100,
        tools: [registeredSearch()],
      }),
    ).resolves.toMatchObject({ status: 'inconclusive', reason: 'invalid_model_response' })
  })

  it('preserves partial text when the model stops at max_tokens', async () => {
    const model = new ScriptedToolModel([
      response('max_tokens', [{ type: 'text', text: '未完成正文' }]),
    ])
    await expect(
      new ToolLoopRunner(model).run({
        operation: 'test',
        promptVersion: 'p1',
        toolsetVersion: 't1',
        system: 'system',
        user: 'user',
        maxTokens: 100,
        tools: [],
      }),
    ).resolves.toMatchObject({
      status: 'inconclusive',
      reason: 'max_tokens',
      partialText: '未完成正文',
    })
  })

  it.each([
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'pause_turn'],
  ] as const)('maps %s to an explicit inconclusive reason', async (stopReason, reason) => {
    const model = new ScriptedToolModel([
      response(stopReason, [{ type: 'text', text: '未完成正文' }]),
    ])
    await expect(
      new ToolLoopRunner(model).run({
        operation: 'test',
        promptVersion: 'p1',
        toolsetVersion: 't1',
        system: 'system',
        user: 'user',
        maxTokens: 100,
        tools: [],
      }),
    ).resolves.toMatchObject({
      status: 'inconclusive',
      reason,
      partialText: '未完成正文',
    })
  })

  it('rejects whitespace-only final text and end_turn responses containing tool calls', async () => {
    const whitespace = new ToolLoopRunner(
      new ScriptedToolModel([response('end_turn', [{ type: 'text', text: '  \n ' }])]),
    ).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [],
    })
    await expect(whitespace).resolves.toMatchObject({
      status: 'inconclusive',
      reason: 'empty_final_text',
    })

    const contradictory = new ToolLoopRunner(
      new ScriptedToolModel([
        response('end_turn', [
          { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
        ]),
      ]),
    ).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [registeredSearch()],
    })
    await expect(contradictory).resolves.toMatchObject({
      status: 'inconclusive',
      reason: 'invalid_model_response',
    })
  })

  it('stops when the finalization request asks for another tool', async () => {
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
      ]),
      response('tool_use', [
        { type: 'tool_call', id: 's2', name: 'search', input: { query: '二' } },
      ]),
    ])
    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [registeredSearch()],
      maxToolRounds: 1,
    })

    expect(result).toMatchObject({
      status: 'inconclusive',
      reason: 'max_tool_rounds',
      modelRequests: 2,
    })
    expect(result.executions.map((item) => item.toolCallId)).toEqual(['s1'])
  })

  it('records tool-declared errors and model call metadata', async () => {
    const tool: RegisteredTool = {
      name: 'search',
      description: 'fixture search',
      inputSchema: SearchInputSchema,
      async execute() {
        return { content: '服务不可用', isError: true, metadata: { reason: 'auth' } }
      },
    }
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
      ]),
      {
        ...response('end_turn', [{ type: 'text', text: 'done' }]),
        requestId: 'model-request-2',
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    ])
    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: 'user',
      maxTokens: 100,
      tools: [tool],
    })

    expect(result.executions[0]).toMatchObject({
      outcome: 'tool_error',
      isError: true,
      metadata: { reason: 'auth' },
    })
    expect(result.modelCalls[1]).toEqual({
      provider: 'scripted-tool-provider',
      model: 'fixture-tool-model',
      stopReason: 'end_turn',
      requestId: 'model-request-2',
      usage: { inputTokens: 10, outputTokens: 3 },
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid per-tool maxCalls %s',
    async (maxCalls) => {
      const model = new ScriptedToolModel([
        response('end_turn', [{ type: 'text', text: 'unused' }]),
      ])
      await expect(
        new ToolLoopRunner(model).run({
          operation: 'test',
          promptVersion: 'p1',
          toolsetVersion: 't1',
          system: 'system',
          user: 'user',
          maxTokens: 100,
          tools: [registeredSearch({ maxCalls })],
        }),
      ).rejects.toThrow('maxCalls for search must be a non-negative integer')
      expect(model.requests).toHaveLength(0)
    },
  )

  it('isolates transcript and tool schemas from adapter mutation', async () => {
    const firstResponse = response('tool_use', [
      { type: 'tool_call', id: 's1', name: 'search', input: { query: '原始查询' } },
    ])
    const requests: ToolModelRequest[] = []
    let secondSchemaType: unknown
    const model: ToolModel = {
      async generateWithTools(request) {
        requests.push(request)
        request.messages[0]!.content[0] = { type: 'text', text: '被 adapter 修改' }
        if (requests.length === 1) {
          request.tools[0]!.inputSchema.type = 'mutated'
          return firstResponse
        }
        secondSchemaType = request.tools[0]!.inputSchema.type
        ;(firstResponse.blocks[0] as { input: JsonObject }).input.query = '被延迟修改'
        return response('end_turn', [{ type: 'text', text: 'done' }])
      },
    }

    const result = await new ToolLoopRunner(model).run({
      operation: 'test',
      promptVersion: 'p1',
      toolsetVersion: 't1',
      system: 'system',
      user: '原始用户输入',
      maxTokens: 100,
      tools: [registeredSearch()],
    })

    expect(result.status).toBe('completed')
    expect(result.transcript[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '原始用户输入' }],
    })
    expect(result.transcript[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_call', input: { query: '原始查询' } }],
    })
    expect(secondSchemaType).toBe('object')
  })
})

function readyResearch(): Extract<ResearchResult, { status: 'ready' }> {
  return {
    status: 'ready',
    query: 'Agent 评测',
    summary: '- [1] 可验证事实',
    sources: [
      {
        title: '来源标题',
        url: 'https://example.com/source',
        content: '不应进入 Writer tool_result 的原始摘要',
        publishedAt: '2026-08-01',
        score: 0.9,
      },
    ],
    request: {
      query: 'Agent 评测',
      topic: 'general',
      searchDepth: 'advanced',
      maxResults: 5,
      startDate: '2025-08-07',
      endDate: '2026-08-07',
    },
    provider: 'scripted-search',
    requestId: 'search-1',
  }
}

function freshBudget() {
  return { totalCalls: 0, callsByTool: {} }
}

describe('WriterService', () => {
  it('derives provider JSON Schema and runtime validation from the same strict schemas', () => {
    expect(SEARCH_TOOL_DEFINITION.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    })
    expect(DIAGRAM_TOOL_DEFINITION.inputSchema).toMatchObject({
      type: 'object',
      required: ['diagram_type', 'mermaid_code'],
      additionalProperties: false,
    })
    expect(SearchToolInputSchema.safeParse({ query: '可验证查询', extra: true }).success).toBe(
      false,
    )
    expect(
      DiagramToolInputSchema.safeParse({
        diagram_type: 'flowchart',
        mermaid_code: '',
      }).success,
    ).toBe(false)
  })

  it('builds a versioned Writer request with coverage, budgets, style, and review feedback', async () => {
    const model = new ScriptedToolModel([
      response('end_turn', [{ type: 'text', text: '正文' }]),
    ])
    const writer = new WriterService(model, { style: '科普' })
    const result = await writer.write({
      topic: 'Agent 工程',
      outline: '1. 工具循环',
      chapterTitle: '工具循环',
      coveragePoints: [{ text: '解释循环', searchQuery: 'Agent tool loop' }],
      reviewFeedback: '补充失败路径',
      chapterWords: 300,
      targetWords: 1000,
      budgetUsage: freshBudget(),
    })

    expect(result).toMatchObject({ status: 'ready', content: '正文' })
    expect(model.requests[0]).toMatchObject({
      operation: 'writer.chapter',
      promptVersion: PROMPT_VERSIONS.writer,
      toolsetVersion: TOOLSET_VERSIONS.writer,
      maxTokens: 660,
      metadata: { chapterTitle: '工具循环', searchEnabled: false },
    })
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(['generate_diagram'])
    expect(model.requests[0]?.system).toContain('面向普通读者')
    expect(model.requests[0]?.system).toContain('本章字数上限：约 300 字')
    expect(model.requests[0]?.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('审稿意见：补充失败路径'),
    })
    expect(model.requests[0]?.messages[0]?.content[0]).toMatchObject({
      text: expect.stringContaining('- 解释循环'),
    })
  })

  it('feeds compact research citations to the model and retains structured provenance', async () => {
    const model = new ScriptedToolModel([
      response('tool_use', [
        {
          type: 'tool_call',
          id: 'search-call-1',
          name: 'search',
          input: { query: 'Agent 评测' },
        },
      ]),
      response('end_turn', [{ type: 'text', text: '引用后的正文' }]),
    ])
    const signals: Array<AbortSignal | undefined> = []
    const controller = new AbortController()
    const writer = new WriterService(model, {
      research: async (_query, signal) => {
        signals.push(signal)
        return readyResearch()
      },
    })

    const result = await writer.write({
      topic: 'Agent 工程',
      outline: '1. 评测',
      chapterTitle: '评测',
      budgetUsage: freshBudget(),
      signal: controller.signal,
    })

    expect(result.status).toBe('ready')
    expect(signals).toEqual([controller.signal])
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'search',
      'generate_diagram',
    ])
    const toolResultMessage = model.requests[1]?.messages.at(-1)
    expect(toolResultMessage).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'search-call-1',
          isError: false,
          content: expect.stringContaining('https://example.com/source'),
        },
      ],
    })
    expect(JSON.stringify(toolResultMessage)).not.toContain('不应进入 Writer')
    expect(result.executions[0]?.metadata).toEqual({
      status: 'ready',
      provider: 'scripted-search',
      requestId: 'search-1',
      sources: [
        {
          title: '来源标题',
          url: 'https://example.com/source',
          publishedAt: '2026-08-01',
          score: 0.9,
        },
      ],
    })
  })

  it('renders Mermaid deterministically and reports empty final output as inconclusive', async () => {
    const diagramModel = new ScriptedToolModel([
      response('tool_use', [
        {
          type: 'tool_call',
          id: 'diagram-1',
          name: 'generate_diagram',
          input: { diagram_type: 'flowchart', mermaid_code: 'flowchart LR\nA-->B' },
        },
      ]),
      response('end_turn', [{ type: 'text', text: '含图正文' }]),
    ])
    const diagramResult = await new WriterService(diagramModel).write({
      topic: '流程',
      outline: '1. 流程',
      chapterTitle: '流程',
      budgetUsage: freshBudget(),
    })
    expect(diagramResult.executions[0]).toMatchObject({
      outcome: 'success',
      content: expect.stringContaining('```mermaid\nflowchart LR\nA-->B'),
      metadata: { diagramType: 'flowchart' },
    })

    const emptyResult = await new WriterService(
      new ScriptedToolModel([response('end_turn', [])]),
    ).write({
      topic: '空',
      outline: '1. 空',
      chapterTitle: '空',
      budgetUsage: freshBudget(),
    })
    expect(emptyResult).toMatchObject({ status: 'inconclusive', reason: 'empty_final_text' })
  })

  it('carries the three-search budget across rewrite attempts for the same chapter', async () => {
    const model = new ScriptedToolModel([
      response('tool_use', [
        { type: 'tool_call', id: 's1', name: 'search', input: { query: '一' } },
      ]),
      response('tool_use', [
        { type: 'tool_call', id: 's2', name: 'search', input: { query: '二' } },
      ]),
      response('tool_use', [
        { type: 'tool_call', id: 's3', name: 'search', input: { query: '三' } },
      ]),
      response('end_turn', [{ type: 'text', text: '初稿' }]),
      response('tool_use', [
        { type: 'tool_call', id: 's4', name: 'search', input: { query: '四' } },
      ]),
      response('end_turn', [{ type: 'text', text: '重写稿' }]),
    ])
    const queries: string[] = []
    const writer = new WriterService(model, {
      research: async (query) => {
        queries.push(query)
        return readyResearch()
      },
    })
    const first = await writer.write({
      topic: '预算',
      outline: '1. 预算',
      chapterTitle: '预算',
      budgetUsage: freshBudget(),
    })
    expect(first).toMatchObject({
      status: 'ready',
      budgetUsage: { totalCalls: 3, callsByTool: { search: 3 } },
    })

    const second = await writer.write({
      topic: '预算',
      outline: '1. 预算',
      chapterTitle: '预算',
      budgetUsage: first.budgetUsage,
    })
    expect(queries).toEqual(['一', '二', '三'])
    expect(second.executions[0]).toMatchObject({
      outcome: 'budget_exceeded',
      metadata: { code: 'tool_budget_exceeded' },
    })
    expect(second.budgetUsage).toEqual({ totalCalls: 4, callsByTool: { search: 3 } })
  })

  it('matches the bounded chapter token budget formula', () => {
    expect(maxTokensForChapter()).toBe(4096)
    expect(maxTokensForChapter(100)).toBe(512)
    expect(maxTokensForChapter(300)).toBe(660)
    expect(maxTokensForChapter(2_000)).toBe(4400)
    expect(maxTokensForChapter(10_000)).toBe(8192)
  })

  it('marks unavailable research as an error without presenting it as evidence', () => {
    const rendered = renderResearchToolResult({
      status: 'unavailable',
      query: '查询',
      sources: [],
      request: {
        query: '查询',
        topic: 'general',
        searchDepth: 'advanced',
        maxResults: 5,
      },
      stage: 'search',
      reason: 'auth',
      retryable: false,
    })

    expect(rendered).toMatchObject({
      isError: true,
      metadata: { status: 'unavailable', reason: 'auth' },
    })
    expect(rendered.content).toContain('不要把此提示当作资料')
  })
})
