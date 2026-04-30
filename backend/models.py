from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field
import uuid

class StageStatus(str, Enum):
    PLAN = "plan"
    WRITE = "write"
    REVIEW = "review"
    EXPORT = "export"
    DONE = "done"
    ERROR = "error"

class InterventionConfig(BaseModel):
    on_outline: bool = True

class JobRequest(BaseModel):
    topic: str
    intervention: InterventionConfig = Field(default_factory=InterventionConfig)
    style: str = ""
    target_words: Optional[int] = None

class JobState(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    topic: str
    stage: StageStatus = StageStatus.PLAN
    outline: Optional[list[str]] = None
    chapters: list[dict] = Field(default_factory=list)
    intervention: InterventionConfig = Field(default_factory=InterventionConfig)
    style: str = ""
    target_words: Optional[int] = None
    error: Optional[str] = None

class SSEEvent(BaseModel):
    event: str   # "stage_update" | "outline_ready" | "searching" | "reviewing_chapter" | "chapter_done" | "reviewing_full" | "review_done" | "done" | "error"
    data: dict

class ReplyRequest(BaseModel):
    message: str
    outline: Optional[list[str]] = None


# ── LangGraph 状态定义 ─────────────────────────────────────────

from typing import TypedDict

class ChapterState(TypedDict):
    title: str
    content: str
    review_passed: bool
    review_feedback: str
    rewrite_count: int

class WriterState(TypedDict):
    topic: str
    style: str
    target_words: Optional[int]
    outline: list[str]
    chapters: list[ChapterState]
    rewrite_count: int       # 全文重审轮次
    error: Optional[str]
    final_content: str


class ArticlePatchRequest(BaseModel):
    content: str
