/**
 * 章节写作：有界工具循环 + 结构化检索结果。
 *
 * 搜索次数和总 dispatch 上限必须跨 attempt 累计（`budgetUsage` 来自 checkpoint），
 * 否则重写章节会把 3 次 search / 8 次调用上限重置。unavailable/failed 必须标 isError，
 * 模型不得把服务故障提示当研究证据。
 */
import type {
  JsonObject,
  ToolModel,
} from '@vibe-writer/model-runtime'
import { z } from 'zod'
import type { CoveragePoint } from './coverage'
import { formatCoveragePoints } from './coverage'
import { buildChapterPrompts } from './prompts'
import type { ResearchResult } from './research'
import {
  ToolLoopRunner,
  definitionForTool,
  type RegisteredTool,
  type ToolBudgetUsage,
  type ToolExecutionRecord,
  type ToolLoopEvent,
  type ToolLoopInconclusiveReason,
  type ToolModelCallRecord,
} from './tool-loop'
import { PROMPT_VERSIONS, TOOLSET_VERSIONS } from './versions'

export const DiagramToolInputSchema = z.object({
  diagram_type: z
    .enum(['flowchart', 'sequenceDiagram', 'stateDiagram', 'graph'])
    .describe('图表类型'),
  mermaid_code: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe('完整的 Mermaid 代码，不含 ```mermaid 包裹'),
}).strict()

export const SearchToolInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('搜索词，建议 5-15 字，聚焦可验证的事实与数据'),
}).strict()

const DIAGRAM_TOOL = {
  name: 'generate_diagram',
  description:
    '为当前章节生成一张 Mermaid 图表。当章节涉及流程、架构、状态机、时序等结构性内容时调用。纯概念性或叙述性章节不需要配图。',
  inputSchema: DiagramToolInputSchema,
}
export const DIAGRAM_TOOL_DEFINITION = definitionForTool(DIAGRAM_TOOL)

const SEARCH_TOOL = {
  name: 'search',
  description:
    '搜索与当前章节相关的资料。需要具体数据、案例或技术细节时调用。涉及新闻、政策、市场数据时，搜索词宜带年份或「最新」。',
  inputSchema: SearchToolInputSchema,
}
export const SEARCH_TOOL_DEFINITION = definitionForTool(SEARCH_TOOL)

export type ResearchFn = (
  query: string,
  signal?: AbortSignal,
  effectScope?: string,
) => Promise<ResearchResult>

export type WriterResult =
  | {
      status: 'ready'
      content: string
      executions: ToolExecutionRecord[]
      modelCalls: ToolModelCallRecord[]
      budgetUsage: ToolBudgetUsage
      modelRequests: number
      toolRounds: number
    }
  | {
      status: 'inconclusive'
      reason: ToolLoopInconclusiveReason
      partialContent: string
      executions: ToolExecutionRecord[]
      modelCalls: ToolModelCallRecord[]
      budgetUsage: ToolBudgetUsage
      modelRequests: number
      toolRounds: number
    }

export type WriterInput = {
  topic: string
  outline: string
  chapterTitle: string
  coveragePoints?: CoveragePoint[]
  reviewFeedback?: string
  chapterWords?: number
  targetWords?: number
  /** 整章累计用量，必须从 graph state/checkpoint 传回，不能每次 write 从零开始。 */
  budgetUsage: ToolBudgetUsage
  signal?: AbortSignal
  onToolEvent?: (event: ToolLoopEvent) => void | Promise<void>
  effectScope?: string
}

/** 按章节字数给模型输出留余量；过小会 max_tokens 截断，过大浪费预算。 */
export function maxTokensForChapter(chapterWords?: number): number {
  if (!chapterWords) return 4096
  return Math.min(8192, Math.max(512, Math.trunc(chapterWords * 2.2)))
}

function sourceMetadata(result: ResearchResult): JsonObject[] {
  return result.sources.map((source) => ({
    title: source.title,
    url: source.url,
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    ...(source.score !== undefined ? { score: source.score } : {}),
  }))
}

/** 给模型看 compact 摘要和 URL；执行记录里才保留 provider/request id 与来源元数据。 */
export function renderResearchToolResult(result: ResearchResult): {
  content: string
  isError: boolean
  metadata: JsonObject
} {
  if (result.status === 'ready') {
    const citations = result.sources
      .map((source, index) => {
        const date = source.publishedAt ? `，${source.publishedAt}` : ''
        return `[${index + 1}] ${source.title}${date}\n${source.url}`
      })
      .join('\n')
    return {
      content: `${result.summary}\n\n可引用来源：\n${citations}`,
      isError: false,
      metadata: {
        status: result.status,
        provider: result.provider,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        sources: sourceMetadata(result),
      },
    }
  }
  if (result.status === 'empty') {
    // empty 不是故障：模型可以换词再搜，但不能把「没找到」写成已引用资料。
    return {
      content: '未找到可用来源，请调整查询或基于已有信息继续。',
      isError: false,
      metadata: {
        status: result.status,
        provider: result.provider,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        sources: [],
      },
    }
  }
  return {
    content:
      result.status === 'unavailable'
        ? '搜索服务当前不可用，请基于已有信息继续，且不要把此提示当作资料。'
        : '搜索或资料提炼失败，请调整查询或基于已有信息继续，且不要编造来源。',
    isError: true, // 故障提示绝不能进入「可引用来源」语义。
    metadata: {
      status: result.status,
      stage: result.stage,
      reason: result.reason,
      retryable: result.retryable,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.modelErrorCode ? { modelErrorCode: result.modelErrorCode } : {}),
      sources: sourceMetadata(result),
    },
  }
}

function diagramTool(): RegisteredTool {
  return {
    ...DIAGRAM_TOOL,
    async execute(input) {
      // 图表在本地组装 Markdown，不调用外部服务；失败不得冒充已检索事实。
      const parsed = DiagramToolInputSchema.parse(input)
      return {
        content: `\`\`\`mermaid\n${parsed.mermaid_code}\n\`\`\`\n\n（图表已生成，请将以上代码块插入章节正文的合适位置）`,
        metadata: { diagramType: parsed.diagram_type },
      }
    },
  }
}

function searchTool(research: ResearchFn): RegisteredTool {
  return {
    ...SEARCH_TOOL,
    maxCalls: 3, // 单章搜索上限；超限仍回 error result，不跳过 tool_use 协议。
    async execute(input, context) {
      const parsed = SearchToolInputSchema.parse(input)
      return renderResearchToolResult(
        await research(parsed.query, context.signal, context.effectScope),
      )
    },
  }
}

export class WriterService {
  private readonly loop: ToolLoopRunner

  constructor(
    model: ToolModel,
    private readonly options: { style?: string; research?: ResearchFn } = {},
  ) {
    this.loop = new ToolLoopRunner(model)
  }

  async write(input: WriterInput): Promise<WriterResult> {
    const coveragePoints = input.coveragePoints ?? []
    const prompts = buildChapterPrompts({
      topic: input.topic,
      outline: input.outline,
      chapterTitle: input.chapterTitle,
      coverageText: formatCoveragePoints(coveragePoints),
      searchHints: coveragePoints.map((point) => point.searchQuery),
      reviewFeedback: input.reviewFeedback,
      chapterWords: input.chapterWords,
      targetWords: input.targetWords,
      style: this.options.style,
      searchEnabled: Boolean(this.options.research),
    })
    const tools = [diagramTool()]
    // 未注入 research 时不注册 search，避免模型发出无法落地的 tool_call。
    if (this.options.research) tools.unshift(searchTool(this.options.research))

    const result = await this.loop.run({
      operation: 'writer.chapter',
      promptVersion: PROMPT_VERSIONS.writer,
      toolsetVersion: TOOLSET_VERSIONS.writer,
      system: prompts.system,
      user: prompts.user,
      maxTokens: maxTokensForChapter(input.chapterWords),
      tools,
      maxToolRounds: 8,
      maxTotalCalls: 8,
      budgetUsage: input.budgetUsage,
      signal: input.signal,
      metadata: {
        chapterTitle: input.chapterTitle,
        searchEnabled: Boolean(this.options.research),
        ...(input.effectScope ? { effectScope: input.effectScope } : {}),
      },
      onEvent: input.onToolEvent,
    })

    // 空白正文、max_tokens、refusal、轮次耗尽都不是成功章节，交给工作流策略重试或失败。
    if (result.status === 'completed') {
      return {
        status: 'ready',
        content: result.text,
        executions: result.executions,
        modelCalls: result.modelCalls,
        budgetUsage: result.budgetUsage,
        modelRequests: result.modelRequests,
        toolRounds: result.toolRounds,
      }
    }
    return {
      status: 'inconclusive',
      reason: result.reason,
      partialContent: result.partialText,
      executions: result.executions,
      modelCalls: result.modelCalls,
      budgetUsage: result.budgetUsage,
      modelRequests: result.modelRequests,
      toolRounds: result.toolRounds,
    }
  }
}
