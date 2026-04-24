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
    on_outline: bool = True   # pause after outline generation
    on_chapter: bool = False  # pause after each chapter

class JobRequest(BaseModel):
    topic: str
    intervention: InterventionConfig = Field(default_factory=InterventionConfig)

class JobState(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    topic: str
    stage: StageStatus = StageStatus.PLAN
    outline: Optional[list[str]] = None
    chapters: list[dict] = Field(default_factory=list)
    intervention: InterventionConfig = Field(default_factory=InterventionConfig)
    error: Optional[str] = None

class SSEEvent(BaseModel):
    event: str   # "stage_update" | "outline_ready" | "searching" | "reviewing_chapter" | "chapter_done" | "reviewing_full" | "review_done" | "done" | "error"
    data: dict

class ReplyRequest(BaseModel):
    message: str
