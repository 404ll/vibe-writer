/**
 * 领域组件与提示词的显式身份。
 *
 * 这些字符串会进入 Job/Run 的 executionConfig 和评测基线。修改提示词或工具集
 * 而不 bump 对应版本，会导致旧检查点/旧评测在“当前提示词”下静默续跑，结果无法对账。
 */
export const AGENT_CORE_VERSION = 'agent-core-v1'
export const PROMPT_SET_VERSION = 'prompt-set-v1-target-2026-08-07'

export const PROMPT_VERSIONS = {
  planner: 'planner-v1-python-baseline-2026-08-07',
  outlineRevision: 'outline-revision-v1-target-2026-08-07',
  coveragePlanner: 'coverage-planner-v1-target-2026-08-07',
  research: 'research-v1-target-2026-08-07',
  writer: 'writer-v1-target-2026-08-07',
  chapterReviewer: 'chapter-reviewer-v1-python-baseline-2026-08-07',
  fullReviewer: 'full-reviewer-v1-python-baseline-2026-08-07',
} as const

export const TOOLSET_VERSIONS = {
  writer: 'writer-tools-v2-web-research-2026-09-03',
} as const
