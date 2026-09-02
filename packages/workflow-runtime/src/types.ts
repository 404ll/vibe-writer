import type {
  CoveragePlanResult,
  ReviewResult,
  WriterResult,
} from '@vibe-writer/agent-core'
import type { JobEvent } from '@vibe-writer/contracts/jobs/events'
import type { ChapterWorkflowState } from './state'

// 本文件只放 TypeScript 编译期类型，运行时不会生成对应 JavaScript 对象。

// Graph 中真实注册的节点名称及职责：
// - __start__：LangGraph 虚拟起点，不执行写作业务；
// - plan：根据主题生成初始大纲；
// - outline_review：暂停并等待用户确认或要求修改大纲；
// - revise_outline：根据用户反馈重新生成大纲；
// - initialize_chapters：把大纲标题初始化成逐章状态；
// - coverage：为当前章节规划需要覆盖的论点和搜索方向；
// - write：生成或重写当前章节；
// - light_review：审核当前章节，并决定是否局部重写；
// - next_chapter：移动 currentChapterIndex；
// - full_review：全文审核，并决定导出或进入全文重写轮次；
// - export：把所有章节拼成最终 Markdown 和幂等导出意图。
// `completed`、`failed` 等是 Workflow State 的 phase，不是独立节点。
// phase 是给业务状态和 UI 使用的粗粒度阶段，节点名是 Graph 内部的细粒度步骤，
// 因此 coverage、light_review 等节点可以共同归在 write/review 阶段下。
export type WorkflowNodeName =
  | '__start__'
  | 'plan'
  | 'outline_review'
  | 'revise_outline'
  | 'initialize_chapters'
  | 'coverage'
  | 'write'
  | 'light_review'
  | 'next_chapter'
  | 'full_review'
  | 'export'

/**
 * Graph 只产生非终态进度事件；done/cancelled/error 仍由数据库终态事务提交。
 * idempotencyKey 必须只由稳定的章节、轮次和尝试次数组成，保证 Checkpoint
 * replay 或 Worker takeover 时不会重复生成同一条业务事件。
 */
export type WorkflowProgressEvent = {
  idempotencyKey: string
  event: Exclude<JobEvent, { event: 'done' | 'cancelled' | 'error' | 'outline_ready' }>
}

/** Worker 注入的持久化端口；Workflow Runtime 不知道 PostgreSQL 或 SSE。 */
export type WorkflowProgressSink = (progress: WorkflowProgressEvent) => Promise<void>

/** Writer 内部真实联网工具调用的最小进度，不携带网页正文或供应商密钥。 */
export type WorkflowResearchProgress =
  | { tool: 'search'; phase: 'started'; query: string; index: number }
  | {
      tool: 'search'
      phase: 'finished'
      query: string
      index: number
      preview: string
      chars: number
    }
  | { tool: 'extract_webpage'; phase: 'started'; url: string; index: number }
  | {
      tool: 'extract_webpage'
      phase: 'finished'
      url: string
      index: number
      sourceTitle?: string
      chars: number
      status: 'ready' | 'failed' | 'unavailable'
    }

// Graph 依赖的领域服务端口。节点只知道“规划、写作、审核”这些能力，
// 不知道背后使用哪个模型、搜索供应商或测试替身。
export type WorkflowServices = {
  /** 根据主题生成第一版章节标题。 */
  plan(input: {
    topic: string
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<string[]>
  /** 根据人工反馈重做大纲，完成后仍需回到 outline_review。 */
  reviseOutline(input: {
    topic: string
    outline: string[]
    feedback: string
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<string[]>
  /** 为一个章节生成待覆盖论点及对应搜索词。 */
  planCoverage(input: {
    topic: string
    outline: string
    chapterTitle: string
    signal?: AbortSignal
    effectScope?: string
  }): Promise<CoveragePlanResult>
  /** 根据覆盖点、审核反馈和工具预算生成或重写一个章节。 */
  writeChapter(input: {
    topic: string
    outline: string
    chapterTitle: string
    coveragePoints: ChapterWorkflowState['coveragePoints']
    reviewFeedback: string
    chapterWords?: number
    targetWords?: number
    budgetUsage: ChapterWorkflowState['toolBudgetUsage']
    style?: string
    signal?: AbortSignal
    effectScope?: string
    onResearchProgress?: (progress: WorkflowResearchProgress) => Promise<void>
  }): Promise<WriterResult>
  /** 对当前章节做轻量审核，结果决定是否回到 write。 */
  reviewChapter(input: {
    chapterTitle: string
    content: string
    outline: string
    chapterWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ReviewResult>
  /** 对全部章节统一审核，结果决定导出或进入全文重写轮次。 */
  reviewFull(input: {
    topic: string
    chapters: Array<{ title: string; content: string }>
    targetWords?: number
    signal?: AbortSignal
    effectScope?: string
  }): Promise<ReviewResult[]>
}
