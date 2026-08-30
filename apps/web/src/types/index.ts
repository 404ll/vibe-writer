import type { SSEEventType } from '@/lib/sseEvents'
import type { StageStatus } from '@vibe-writer/contracts/jobs'

export type {
  ChapterEvent,
  JobLifecycleEvent,
  PlanningEvent,
  ReviewEvent,
  SSEEventType,
} from '@/lib/sseEvents'
export type { InterventionConfig, ReviewResult, StageStatus } from '@vibe-writer/contracts/jobs'

export const WORD_COUNT_OPTIONS = [
  { label: '短文', words: 800 },
  { label: '中篇', words: 2000 },
  { label: '长文', words: 4000 },
  { label: '不限制', words: null },
] as const

export interface ActivityEntry {
  id: number;
  status: "running" | "success" | "failed" | "info";
  message: string;
}

export interface JobState {
  jobId: string;
  stage: StageStatus;
  outline: string[] | null;
  chapters: { title: string; content: string }[];
  error: string | null;
}

export interface SSEPayload {
  event: SSEEventType;
  data: Record<string, unknown>;
}
