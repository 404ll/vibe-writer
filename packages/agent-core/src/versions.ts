/**
 * 领域组件与提示词的显式身份。
 *
 * 这些字符串会进入 Job/Run 的 executionConfig 和评测基线。修改提示词或工具集
 * 而不 bump 对应版本，会导致旧检查点/旧评测在“当前提示词”下静默续跑，结果无法对账。
 */
export const AGENT_CORE_VERSION = 'agent-core-v2-writer-reviewer-2026-09-03'
export const PROMPT_SET_VERSION = 'prompt-set-v2-writer-reviewer-2026-09-03'

export const PROMPT_VERSIONS = {
  planner: 'planner-v2-writing-brief-2026-09-03',
  outlineRevision: 'outline-revision-v2-editorial-decisions-2026-09-03',
  coveragePlanner: 'coverage-planner-v2-prompt-refresh-2026-09-03',
  research: 'research-v2-prompt-refresh-2026-09-03',
  writer: 'writer-v2-prompt-refresh-2026-09-03',
  writerAgent: 'writer-agent-v1-full-article-2026-09-03',
  chapterReviewer: 'chapter-reviewer-v2-prompt-refresh-2026-09-03',
  fullReviewer: 'full-reviewer-v2-prompt-refresh-2026-09-03',
  reviewerAgent: 'reviewer-agent-v1-full-article-2026-09-03',
} as const

export const TOOLSET_VERSIONS = {
  writer: 'writer-tools-v1-target-2026-08-07',
  writerAgent: 'writer-agent-tools-v1-search-diagram-2026-09-03',
} as const
