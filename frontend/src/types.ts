export type StageStatus = "plan" | "write" | "review" | "export" | "done" | "error";

export interface InterventionConfig {
  on_outline: boolean;
}

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
  | "searching"
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
