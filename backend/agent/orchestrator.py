import os
import re
from backend.models import StageStatus, SSEEvent
from backend.store import job_store
from backend.routers.jobs import push_event
from backend.agent.planner import PlannerAgent
from backend.agent.search import SearchAgent
from backend.agent.writer import WriterAgent

class Orchestrator:
    """
    流水线协调者：不再持有 LLM 客户端，只负责调度三个 Agent 并管理阶段状态。

    阶段：
      PLAN  → PlannerAgent 生成大纲
      WRITE → 每章：SearchAgent 搜索 → WriterAgent 写作
      EXPORT → 拼接 Markdown，写文件
    """

    def __init__(self, job_id: str, topic: str, intervention_on_outline: bool = True, intervention_on_chapter: bool = False):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self.intervention_on_chapter = intervention_on_chapter
        self._planner = PlannerAgent()
        self._search = SearchAgent()
        self._writer = WriterAgent()

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        """把主题字符串转成安全的文件名"""
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)
        return slug[:max_len].rstrip('-') or 'output'

    async def run(self):
        """主流水线：PLAN → WRITE → EXPORT"""
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
            event="outline_ready",
            data={"outline": chapters},
        ))

        if self.intervention_on_outline:
            reply = await job_store.wait_for_reply(self.job_id)
            if reply and reply.strip().lower() not in ("ok", "确认", "继续", "yes"):
                revised = self._planner._parse_outline(reply)
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
            await push_event(self.job_id, SSEEvent(
                event="searching", data={"title": chapter_title}
            ))
            research = await self._search.search(chapter_title)

            content = await self._writer.write(
                topic=self.topic,
                outline=outline_text,
                chapter_title=chapter_title,
                research=research,
            )
            written_chapters.append({"title": chapter_title, "content": content})
            job.chapters = written_chapters
            job_store.update(job)

            await push_event(self.job_id, SSEEvent(
                event="chapter_done",
                data={"title": chapter_title, "index": len(written_chapters) - 1},
            ))

            if self.intervention_on_chapter:
                await job_store.wait_for_reply(self.job_id)

        # ── Stage 3: EXPORT ────────────────────────────────────────
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
            event="done", data={"output_path": output_path},
        ))

    def _build_markdown(self, topic: str, chapters: list[dict]) -> str:
        """把章节列表拼成标准 Markdown 文档"""
        lines = [f"# {topic}\n"]
        for ch in chapters:
            lines.append(f"\n## {ch['title']}\n")
            lines.append(ch["content"])
        return "\n".join(lines)
