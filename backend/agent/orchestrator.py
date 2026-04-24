import os
import re
import anthropic
from backend.models import JobState, StageStatus, SSEEvent
from backend.store import job_store
from backend.routers.jobs import push_event
from backend.agent.prompts import (
    OUTLINE_SYSTEM, OUTLINE_USER,
    CHAPTER_SYSTEM, CHAPTER_USER,
)

class Orchestrator:
    def __init__(self, job_id: str, topic: str, intervention_on_outline: bool = True, intervention_on_chapter: bool = False):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self.intervention_on_chapter = intervention_on_chapter
        self._client = anthropic.AsyncAnthropic(
            api_key=os.environ.get("ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.environ.get("ANTHROPIC_BASE_URL"),
        )

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)
        return slug[:max_len].rstrip('-') or 'output'

    def _parse_outline(self, raw: str) -> list[str]:
        chapters = []
        for line in raw.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            # Strip leading "1. " or "1、" numbering
            if line[0].isdigit():
                dot_idx = line.find(".")
                space_idx = line.find("、")
                if dot_idx != -1:
                    line = line[dot_idx + 1:].strip()
                elif space_idx != -1:
                    line = line[space_idx + 1:].strip()
            if line:
                chapters.append(line)
        return chapters

    async def _call_llm(self, system: str, user: str) -> str:
        message = await self._client.messages.create(
            model=os.environ.get("MODEL_ID", "kimi-k2.5"),
            max_tokens=2048,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return message.content[0].text

    async def run(self):
        job = job_store.get(self.job_id)
        if not job:
            await push_event(self.job_id, SSEEvent(
                event="error", data={"message": "Job not found"}
            ))
            return

        # --- Stage: PLAN ---
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.PLAN}
        ))
        raw_outline = await self._call_llm(
            OUTLINE_SYSTEM,
            OUTLINE_USER.format(topic=self.topic),
        )
        chapters = self._parse_outline(raw_outline)
        if job:
            job.outline = chapters
            job_store.update(job)

        await push_event(self.job_id, SSEEvent(
            event="outline_ready",
            data={"outline": chapters, "raw": raw_outline},
        ))

        # Pause for user confirmation if configured
        if self.intervention_on_outline:
            reply = await job_store.wait_for_reply(self.job_id)
            # User may have revised the outline; re-parse if they sent a new one
            if reply and reply.strip().lower() not in ("ok", "确认", "继续", "yes"):
                chapters = self._parse_outline(reply) or chapters
                if job:
                    job.outline = chapters
                    job_store.update(job)

        # --- Stage: WRITE ---
        if job:
            job.stage = StageStatus.WRITE
            job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.WRITE}
        ))

        outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chapters))
        written_chapters = []
        for chapter_title in chapters:
            content = await self._call_llm(
                CHAPTER_SYSTEM,
                CHAPTER_USER.format(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                ),
            )
            written_chapters.append({"title": chapter_title, "content": content})
            if job:
                job.chapters = written_chapters
                job_store.update(job)
            await push_event(self.job_id, SSEEvent(
                event="chapter_done",
                data={"title": chapter_title, "index": len(written_chapters) - 1},
            ))
            if self.intervention_on_chapter:
                await job_store.wait_for_reply(self.job_id)

        # --- Stage: EXPORT ---
        if job:
            job.stage = StageStatus.EXPORT
            job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.EXPORT}
        ))

        markdown = self._build_markdown(self.topic, written_chapters)
        output_path = f"output/{self._safe_filename(self.topic)}.md"
        os.makedirs("output", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(markdown)

        if job:
            job.stage = StageStatus.DONE
            job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="done", data={"output_path": output_path},
        ))

    def _build_markdown(self, topic: str, chapters: list[dict]) -> str:
        lines = [f"# {topic}\n"]
        for ch in chapters:
            lines.append(f"\n## {ch['title']}\n")
            lines.append(ch["content"])
        return "\n".join(lines)
