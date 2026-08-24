// 迁移期兼容入口：现有 Web 继续从本文件导入，真正的契约由共享 package 维护。
export {
  SSE_EVENT_GROUPS,
  SSE_EVENT_TYPES,
  TERMINAL_EVENTS,
} from '@vibe-writer/contracts/jobs/event-types'

export type {
  ChapterEvent,
  JobLifecycleEvent,
  PlanningEvent,
  ReviewEvent,
  SSEEventType,
} from '@vibe-writer/contracts/jobs/event-types'
