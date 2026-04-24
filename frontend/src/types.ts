export type StageStatus = "plan" | "write" | "export" | "done" | "error";

export interface InterventionConfig {
  on_outline: boolean;
  on_chapter: boolean;
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
  | "chapter_done"
  | "done"
  | "error";

export interface SSEPayload {
  event: SSEEventType;
  data: Record<string, unknown>;
}
