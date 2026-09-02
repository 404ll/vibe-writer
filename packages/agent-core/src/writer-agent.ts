import type { JsonObject, ToolModel } from '@vibe-writer/model-runtime'
import type { ResearchFn } from './writer'
import {
  DiagramToolInputSchema,
  renderResearchToolResult,
  SearchToolInputSchema,
} from './writer'
import {
  ToolLoopRunner,
  type RegisteredTool,
  type ToolExecutionRecord,
  type ToolLoopEvent,
  type ToolLoopInconclusiveReason,
  type ToolModelCallRecord,
} from './tool-loop'
import { buildWriterAgentPrompt, WRITER_AGENT_SYSTEM } from './prompts'
import { PROMPT_VERSIONS, TOOLSET_VERSIONS } from './versions'
import {
  SourceNoteSchema,
  WriterSessionSchema,
  type EditorialDecision,
  type ReviewReport,
  type SourceNote,
  type WriterSession,
  type WritingBrief,
} from './writing-artifacts'

export type WriterAgentInput = {
  brief: WritingBrief
  approvedOutline: string[]
  editorialDecisions: EditorialDecision[]
  session: WriterSession
  reviewReport?: ReviewReport | null
  continuationPrefix?: string
  signal?: AbortSignal
  onToolEvent?: (event: ToolLoopEvent) => void | Promise<void>
  effectScope?: string
}

type WriterAgentBase = {
  session: WriterSession
  sources: SourceNote[]
  executions: ToolExecutionRecord[]
  modelCalls: ToolModelCallRecord[]
}

export type WriterAgentResult =
  | (WriterAgentBase & { status: 'ready'; draft: string })
  | (WriterAgentBase & {
      status: 'inconclusive'
      reason: ToolLoopInconclusiveReason
      partialDraft: string
    })

/** 全文一次生成需要比单章更大的输出空间，但仍有硬上限避免异常请求。 */
export function articleDraftBudget(targetWords?: number | null): number {
  if (!targetWords) return 8_192
  return Math.min(16_384, Math.max(2_048, Math.trunc(targetWords * 2.2)))
}

function diagramTool(): RegisteredTool {
  return {
    name: 'generate_diagram',
    description: '为文章生成必要的 Mermaid 流程图、架构图、时序图或状态图。',
    inputSchema: DiagramToolInputSchema,
    maxCalls: 3,
    async execute(input) {
      const parsed = DiagramToolInputSchema.parse(input)
      return {
        content: `\`\`\`mermaid\n${parsed.mermaid_code}\n\`\`\`\n\n（将该图插入完整文章的合适位置）`,
        metadata: { diagramType: parsed.diagram_type },
      }
    },
  }
}

function searchTool(research: ResearchFn): RegisteredTool {
  return {
    name: 'search',
    description: '搜索整篇文章所需的具体事实、数据、案例或时效信息。',
    inputSchema: SearchToolInputSchema,
    maxCalls: 6,
    async execute(input, context) {
      const parsed = SearchToolInputSchema.parse(input)
      return renderResearchToolResult(
        await research(parsed.query, context.signal, context.effectScope),
      )
    },
  }
}

function sourcesFromExecutions(executions: ToolExecutionRecord[]): SourceNote[] {
  const byUrl = new Map<string, SourceNote>()
  for (const execution of executions) {
    if (execution.name !== 'search' || execution.outcome !== 'success') continue
    const raw = execution.metadata?.sources
    if (!Array.isArray(raw)) continue
    for (const source of raw) {
      const parsed = SourceNoteSchema.safeParse(
        typeof source === 'object' && source !== null && !Array.isArray(source)
          ? { ...source, evidence: execution.content.slice(0, 2_000) }
          : source,
      )
      if (parsed.success) byUrl.set(parsed.data.url, parsed.data)
    }
  }
  return [...byUrl.values()]
}

function sessionFromResult(result: {
  transcript: WriterSession['messages']
  budgetUsage: WriterSession['budgetUsage']
}): WriterSession {
  return WriterSessionSchema.parse({
    version: 'writer-session-v1',
    messages: result.transcript,
    budgetUsage: result.budgetUsage,
  }) as WriterSession
}

/**
 * 一个 Writer Agent 对首稿与返工负责。Reviewer 只把结构化报告追加成新的 user
 * turn，因此 Writer 可以复用自己已经看到的资料，却不会接触 Reviewer 的私有推理。
 */
export class WriterAgentService {
  private readonly loop: ToolLoopRunner

  constructor(
    model: ToolModel,
    private readonly options: { research?: ResearchFn } = {},
  ) {
    this.loop = new ToolLoopRunner(model)
  }

  async write(input: WriterAgentInput): Promise<WriterAgentResult> {
    const tools = [diagramTool()]
    if (this.options.research) tools.unshift(searchTool(this.options.research))
    const continuation = Boolean(input.continuationPrefix)
    const result = await this.loop.run({
      operation: continuation ? 'writer-agent.continue' : 'writer-agent.compose',
      promptVersion: PROMPT_VERSIONS.writerAgent,
      toolsetVersion: TOOLSET_VERSIONS.writerAgent,
      system: `${WRITER_AGENT_SYSTEM}${input.brief.styleInstruction ? `\n\n${input.brief.styleInstruction}` : ''}`,
      user: buildWriterAgentPrompt({
        brief: input.brief,
        approvedOutline: input.approvedOutline,
        editorialDecisions: input.editorialDecisions,
        reviewReport: input.reviewReport,
        continuation,
      }),
      initialMessages: input.session.messages,
      maxTokens: articleDraftBudget(input.brief.targetWords),
      tools,
      maxToolRounds: 8,
      maxTotalCalls: 10,
      budgetUsage: input.session.budgetUsage,
      signal: input.signal,
      metadata: {
        searchEnabled: Boolean(this.options.research),
        writingMode: continuation ? 'continuation' : input.reviewReport ? 'revision' : 'initial',
        ...(input.effectScope ? { effectScope: input.effectScope } : {}),
      } satisfies JsonObject,
      onEvent: input.onToolEvent,
    })
    const session = sessionFromResult(result)
    const sources = sourcesFromExecutions(result.executions)
    if (result.status === 'completed') {
      return {
        status: 'ready',
        draft: `${input.continuationPrefix ?? ''}${result.text}`,
        session,
        sources,
        executions: result.executions,
        modelCalls: result.modelCalls,
      }
    }
    return {
      status: 'inconclusive',
      reason: result.reason,
      partialDraft: `${input.continuationPrefix ?? ''}${result.partialText}`,
      session,
      sources,
      executions: result.executions,
      modelCalls: result.modelCalls,
    }
  }
}
