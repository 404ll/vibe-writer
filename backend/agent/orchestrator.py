import asyncio
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
      WRITE  → 所有章节并行：搜索 → 写作 → 轻审（不通过重写一次）
      REVIEW → 重审全文（不通过的章节各重写一次）
      EXPORT → 拼接 Markdown，写文件
    """

    def __init__(
        self,
        job_id: str,
        topic: str,
        intervention_on_outline: bool = True,
        style: str = "",
    ):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self._planner = PlannerAgent()
        self._search = SearchAgent()
        self._writer = WriterAgent(style=style)
        self._reviewer = ReviewAgent()

    def _safe_filename(self, text: str, max_len: int = 30) -> str:
        slug = re.sub(r'[^\w\-\u4e00-\u9fff]', '-', text)
        slug = re.sub(r'-+', '-', slug)
        return slug[:max_len].rstrip('-') or 'output'

    async def _write_chapter(
        self,
        chapter_title: str,
        outline_text: str,
        index: int,
    ) -> dict:
        """单章完整流程：搜索 → 写作 → 轻审（不通过重写一次）。
        失败时最多重试 3 次（指数退避：1s, 2s）。
        3 次全部失败时返回含 error 字段的 dict，不抛出异常。
        """
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                if attempt > 0:
                    await asyncio.sleep(2 ** (attempt - 1))  # 1s, 2s

                # 每次重试前也检查取消标志
                if job_store.is_cancelled(self.job_id):
                    raise asyncio.CancelledError("用户取消")

                await push_event(self.job_id, SSEEvent(
                    event="searching",
                    data={"title": chapter_title, **({"retry": attempt} if attempt > 0 else {})},
                ))
                research = await self._search.search(chapter_title)

                content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                    research=research,
                )

                await push_event(self.job_id, SSEEvent(
                    event="reviewing_chapter", data={"title": chapter_title}
                ))
                review = await self._reviewer.review_chapter(
                    chapter_title=chapter_title,
                    content=content,
                    outline=outline_text,
                )
                if not review.passed:
                    content = await self._writer.write(
                        topic=self.topic,
                        outline=outline_text,
                        chapter_title=chapter_title,
                        research=research,
                        review_feedback=review.feedback,
                    )

                await push_event(self.job_id, SSEEvent(
                    event="chapter_done",
                    data={
                        "title": chapter_title,
                        "index": index,
                        "review": {"passed": review.passed, "feedback": review.feedback},
                    },
                ))
                return {"title": chapter_title, "content": content, "index": index, "research": research}

            except asyncio.CancelledError:
                raise  # 取消信号不能被重试逻辑吞掉，直接向上传播
            except Exception as e:
                last_error = e

        # 3 次全部失败
        return {"title": chapter_title, "content": "", "index": index, "research": "", "error": str(last_error)}

    def _check_cancelled(self):
        """如果用户已请求取消，抛出异常退出流水线"""
        if job_store.is_cancelled(self.job_id):
            raise asyncio.CancelledError("用户取消")

    async def run(self):
        job = job_store.get(self.job_id)
        if not job:
            await push_event(self.job_id, SSEEvent(
                event="error", data={"message": "Job not found"}
            ))
            return

        try:
            await self._run_pipeline(job)
        except asyncio.CancelledError:
            job = job_store.get(self.job_id)
            if job:
                job.stage = StageStatus.ERROR
                job.error = "已取消"
                job_store.update(job)
            await push_event(self.job_id, SSEEvent(event="cancelled", data={}))

    async def _run_pipeline(self, job):
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
            # 等待回复后再检查——用户可能在等待期间点了取消
            self._check_cancelled()
            if reply and reply.strip().lower() not in ("ok", "确认", "继续", "yes"):
                revised = self._planner.parse_outline(reply)
                chapters = revised if revised else chapters
                job.outline = chapters
                job_store.update(job)

        # ── Stage 2: WRITE（并行）─────────────────────────────────
        self._check_cancelled()
        job.stage = StageStatus.WRITE
        job_store.update(job)
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.WRITE}
        ))

        outline_text = "\n".join(f"{i+1}. {c}" for i, c in enumerate(chapters))

        tasks = [
            self._write_chapter(title, outline_text, i)
            for i, title in enumerate(chapters)
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 意外异常（理论上不触发，_write_chapter 内部已捕获）
        unexpected = [(i, r) for i, r in enumerate(results) if isinstance(r, Exception)]
        if unexpected:
            error_msgs = "; ".join(f"章节{i+1}: {r}" for i, r in unexpected)
            job.error = f"章节写作异常: {error_msgs}"
            job.stage = StageStatus.ERROR
            job_store.update(job)
            await push_event(self.job_id, SSEEvent(event="error", data={"message": job.error}))
            return

        # 3 次重试全部失败的章节
        failed = [r for r in results if r.get("error")]
        if failed:
            msg = "; ".join(f"{r['title']}: {r['error']}" for r in failed)
            job.error = f"章节写作失败: {msg}"
            job.stage = StageStatus.ERROR
            job_store.update(job)
            await push_event(self.job_id, SSEEvent(event="error", data={"message": job.error}))
            return

        # gather 保证结果顺序与任务顺序一致；sort 作为保险
        written_chapters = sorted(results, key=lambda r: r["index"])

        job.chapters = written_chapters
        job_store.update(job)

        # ── Stage 3: REVIEW ────────────────────────────────────────
        self._check_cancelled()
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
            if not result.passed:
                ch = written_chapters[i]
                new_content = await self._writer.write(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=ch["title"],
                    research=ch.get("research", ""),
                    review_feedback=result.feedback,
                )
                written_chapters[i] = {"title": ch["title"], "content": new_content, "index": i, "research": ch.get("research", "")}

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
        self._check_cancelled()
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

        # 写入数据库（失败不影响主流程）
        try:
            await self._save_article(job.id, self.topic, markdown)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning("Failed to save article to DB: %s", e)

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

    @staticmethod
    def _count_words(text: str) -> int:
        """简单字数统计：中文按字符数，英文按空格分词"""
        import re
        chinese = len(re.findall(r'[\u4e00-\u9fff]', text))
        english = len(re.findall(r'[a-zA-Z]+', text))
        return chinese + english

    @staticmethod
    async def _save_article(job_id: str, topic: str, content: str):
        from backend.database import AsyncSessionLocal
        from backend.models_db import Article
        word_count = Orchestrator._count_words(content)
        async with AsyncSessionLocal() as session:
            article = Article(
                job_id=job_id,
                topic=topic,
                content=content,
                word_count=word_count,
            )
            session.add(article)
            await session.commit()
