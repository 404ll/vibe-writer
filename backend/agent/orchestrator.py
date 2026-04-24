import os
import re
from backend.models import StageStatus, SSEEvent
from backend.store import job_store
from backend.routers.jobs import push_event
from backend.agent.planner import PlannerAgent
from backend.agent.search import SearchAgent
from backend.agent.writer import WriterAgent
from backend.agent.reviewer import ReviewAgent


class Orchestrator:
    """
    流水线协调者：调度 PlannerAgent / SearchAgent / WriterAgent / ReviewAgent。

    阶段：
      PLAN   → PlannerAgent 生成大纲
      WRITE  → 每章：搜索 → 写作 → 轻审（不通过重写一次）
      REVIEW → 重审全文（不通过的章节各重写一次）
      EXPORT → 拼接 Markdown，写文件
    """

    def __init__(
        self,
        job_id: str,
        topic: str,
        intervention_on_outline: bool = True,
        intervention_on_chapter: bool = False,
    ):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self.intervention_on_chapter = intervention_on_chapter
        self._planner = PlannerAgent()
        self._search = SearchAgent()
        self._writer = WriterAgent()
        self._reviewer = ReviewAgent()

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)
        return slug[:max_len].rstrip('-') or 'output'

    async def run(self):
        job = job_store.get(self.job_id)
        if not job:
            await push_event(self.job_id, SSEEvent(
                event="error", data={"message": "Job not found"}
            ))
            return

        # ── Stage 1: PLAN ──────────────────────────────────────────
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.PLAN}
        ))
        chapters = await self._planner.plan(self.topic)
        job.outline = chapters
        job_store.update(job)

        await push_event(self.job_id, SSEEvent(
            event="outline_ready", data={"outline": chapters}
        ))

        if self.intervention_on_outline:
            reply = await job_store.wait_for_reply(self.job_id)
            if reply and reply.strip().lower() not in ("ok", "确认", "继续", "yes"):
                revised = self._planner.parse_outline(reply)
                chapters = revised if revised else chapters
                job.outline = chapters
                job_store.update(job)

        # ── Stage 2: WRITE ─────────────────────────────────────────
        job.stage = StageStatus.WRITE
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.WRITE}
        ))

        outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chapters))
        written_chapters = []

        for chapter_title in chapters:
            # 搜索
            await push_event(self.job_id, SSEEvent(
                event="searching", data={"title": chapter_title}
            ))
            research = await self._search.search(chapter_title)

            # 写作
            content = await self._writer.write(
                topic=self.topic,
                outline=outline_text,
                chapter_title=chapter_title,
                research=research,
            )

            # 轻审
            await push_event(self.job_id, SSEEvent(
                event="reviewing_chapter", data={"title": chapter_title}
            ))
            chapter_review = await self._reviewer.review_chapter(
                chapter_title=chapter_title,
                content=content,
                outline=outline_text,
            )
            if not chapter_review.passed:
                content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                    research=research,
                    review_feedback=chapter_review.feedback,
                )

            written_chapters.append({"title": chapter_title, "content": content})
            job.chapters = written_chapters
            job_store.update(job)

            await push_event(self.job_id, SSEEvent(
                event="chapter_done",
                data={
                    "title": chapter_title,
                    "index": len(written_chapters) - 1,
                    "review": {
                        "passed": chapter_review.passed,
                        "feedback": chapter_review.feedback,
                    },
                },
            ))

            if self.intervention_on_chapter:
                await job_store.wait_for_reply(self.job_id)

        # ── Stage 3: REVIEW ────────────────────────────────────────
        job.stage = StageStatus.REVIEW
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.REVIEW}
        ))
        await push_event(self.job_id, SSEEvent(
            event="reviewing_full", data={}
        ))

        full_results = await self._reviewer.review_full(
            topic=self.topic,
            chapters=written_chapters,
        )

        for i, result in enumerate(full_results):
            if not result.passed and i < len(written_chapters):
                ch = written_chapters[i]
                new_content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=ch["title"],
                    research="",
                    review_feedback=result.feedback,
                )
                written_chapters[i] = {"title": ch["title"], "content": new_content}

        job.chapters = written_chapters
        job_store.update(job)

        await push_event(self.job_id, SSEEvent(
            event="review_done",
            data={
                "results": [
                    {"title": written_chapters[i]["title"], "passed": r.passed, "feedback": r.feedback}
                    for i, r in enumerate(full_results)
                ]
            },
        ))

        # ── Stage 4: EXPORT ────────────────────────────────────────
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

        job.stage = StageStatus.DONE
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="done", data={"output_path": output_path}
        ))

    def _build_markdown(self, topic: str, chapters: list[dict]) -> str:
        lines = [f"# {topic}\n"]
        for ch in chapters:
            lines.append(f"\n## {ch['title']}\n")
            lines.append(ch["content"])
        return "\n".join(lines)
