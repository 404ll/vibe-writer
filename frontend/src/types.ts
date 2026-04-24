export type StageStatus = "plan" | "write" | "review" | "export" | "done" | "error";

export interface InterventionConfig {
  on_outline: boolean;
}

export const WORD_COUNT_OPTIONS = [
  { label: '短文', words: 800 },
  { label: '中篇', words: 2000 },
  { label: '长文', words: 4000 },
  { label: '不限制', words: null },
] as const

export interface ReviewResult {
  passed: boolean;
  feedback: string;
}

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

export type SSEEventType =
  | "stage_update"
  | "outline_ready"
  | "generating_opinions"
  | "opinions_ready"
  | "searching"
  | "writing_chapter"
  | "reviewing_chapter"
  | "chapter_done"
  | "reviewing_full"
  | "review_done"
  | "done"
  | "cancelled"
  | "error";

export interface SSEPayload {
  event: SSEEventType;
  data: Record<string, unknown>;
}
