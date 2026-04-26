import asyncio
import logging
import os
import re
import time
from typing import Optional
from backend.models import StageStatus, SSEEvent
from backend.store import job_store
from backend.routers.jobs import push_event
from backend.agent.planner import PlannerAgent
from backend.agent.opinion import OpinionAgent
from backend.agent.search import SearchAgent
from backend.agent.writer import WriterAgent
from backend.agent.reviewer import ReviewAgent

log = logging.getLogger("vibe.orchestrator")


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
        target_words: Optional[int] = None,
    ):
        self.job_id = job_id
        self.topic = topic
        self.intervention_on_outline = intervention_on_outline
        self.target_words = target_words
        self._planner = PlannerAgent()
        self._opinion = OpinionAgent()
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
        chapter_words: Optional[int] = None,
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

                # 生成论点
                await push_event(self.job_id, SSEEvent(
                    event="generating_opinions",
                    data={"title": chapter_title},
                ))
                t_op = time.monotonic()
                opinions_text, search_queries = await self._opinion.generate(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                )
                log.info("[%s] opinions done  chapter=%r  elapsed=%.2fs",
                         self.job_id[:8], chapter_title, time.monotonic() - t_op)
                await push_event(self.job_id, SSEEvent(
                    event="opinions_ready",
                    data={"title": chapter_title, "opinions": opinions_text},
                ))

                await push_event(self.job_id, SSEEvent(
                    event="searching",
                    data={"title": chapter_title, **({"retry": attempt} if attempt > 0 else {})},
                ))
                t0 = time.monotonic()
                research = await self._search.search(
                    queries=search_queries,
                    opinions=opinions_text,
                )
                log.info("[%s] search done  chapter=%r  len=%d  has_research=%s  elapsed=%.2fs",
                         self.job_id[:8], chapter_title, len(research), bool(research.strip()), time.monotonic() - t0)

                # 流式写作：每个 token 实时推送给前端
                t1 = time.monotonic()
                content_parts: list[str] = []
                async for token in self._writer.write_stream(
                    topic=self.topic,
                    outline=outline_text,
                    chapter_title=chapter_title,
                    research=research,
                    opinions=opinions_text,
                    chapter_words=chapter_words,
                ):
                    content_parts.append(token)
                    await push_event(self.job_id, SSEEvent(
                        event="writing_chapter",
                        data={"title": chapter_title, "token": token},
                    ))
                content = "".join(content_parts)
                log.info("[%s] write done   chapter=%r  tokens=%d  elapsed=%.2fs",
                         self.job_id[:8], chapter_title, len(content), time.monotonic() - t1)

                await push_event(self.job_id, SSEEvent(
                    event="reviewing_chapter", data={"title": chapter_title}
                ))
                t2 = time.monotonic()
                review = await self._reviewer.review_chapter(
                    chapter_title=chapter_title,
                    content=content,
                    outline=outline_text,
                )
                log.info("[%s] review_ch    chapter=%r  passed=%s  elapsed=%.2fs",
                         self.job_id[:8], chapter_title, review.passed, time.monotonic() - t2)

                if not review.passed:
                    log.info("[%s] rewrite      chapter=%r  feedback=%r",
                             self.job_id[:8], chapter_title, review.feedback[:80])
                    # 重写时也用流式（同样推送 token）
                    rewrite_parts: list[str] = []
                    async for token in self._writer.write_stream(
                        topic=self.topic,
                        outline=outline_text,
                        chapter_title=chapter_title,
                        research=research,
                        opinions=opinions_text,
                        review_feedback=review.feedback,
                        chapter_words=chapter_words,
                    ):
                        rewrite_parts.append(token)
                        await push_event(self.job_id, SSEEvent(
                            event="writing_chapter",
                            data={"title": chapter_title, "token": token},
                        ))
                    content = "".join(rewrite_parts)

                    # 二次审：重写后再审一次，不通过则 log warning 并接受当前内容
                    await push_event(self.job_id, SSEEvent(
                        event="reviewing_chapter", data={"title": chapter_title}
                    ))
                    review2 = await self._reviewer.review_chapter(
                        chapter_title=chapter_title,
                        content=content,
                        outline=outline_text,
                    )
                    if not review2.passed:
                        log.warning("[%s] rewrite still failed  chapter=%r  feedback=%r",
                                    self.job_id[:8], chapter_title, review2.feedback[:80])

                await push_event(self.job_id, SSEEvent(
                    event="chapter_done",
                    data={
                        "title": chapter_title,
                        "index": index,
                        "review": {"passed": review.passed, "feedback": review.feedback},
                    },
                ))
                return {"title": chapter_title, "content": content, "index": index, "research": research, "opinions": opinions_text}

            except asyncio.CancelledError:
                raise  # 取消信号不能被重试逻辑吞掉，直接向上传播
            except Exception as e:
                log.warning("[%s] chapter error chapter=%r  attempt=%d  err=%s",
                            self.job_id[:8], chapter_title, attempt, e)
                last_error = e

        # 3 次全部失败
        log.error("[%s] chapter failed chapter=%r  err=%s", self.job_id[:8], chapter_title, last_error)
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
        pipeline_start = time.monotonic()
        log.info("[%s] pipeline start  topic=%r", self.job_id[:8], self.topic)

        # ── Stage 1: PLAN ──────────────────────────────────────────
        await push_event(self.job_id, SSEEvent(
            event="stage_update", data={"stage": StageStatus.PLAN}
        ))
        t0 = time.monotonic()
        chapters = await self._planner.plan(self.topic)
        log.info("[%s] plan done  chapters=%d  elapsed=%.2fs",
                 self.job_id[:8], len(chapters), time.monotonic() - t0)
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
        chapter_words = round(self.target_words / len(chapters)) if self.target_words else None

        tasks = [
            self._write_chapter(title, outline_text, i, chapter_words)
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
        t_review = time.monotonic()
        full_results = await self._reviewer.review_full(
            topic=self.topic,
            chapters=written_chapters,
        )

        failed_count = sum(1 for r in full_results if not r.passed)
        log.info("[%s] review_full done  failed=%d/%d  elapsed=%.2fs",
                 self.job_id[:8], failed_count, len(full_results), time.monotonic() - t_review)

        async def _rewrite(i: int, ch: dict, feedback: str) -> tuple[int, str]:
            new_content = await self._writer.write(
                topic=self.topic,
                outline=outline_text,
                chapter_title=ch["title"],
                research=ch.get("research", ""),
                opinions=ch.get("opinions", ""),
                review_feedback=feedback,
                chapter_words=chapter_words,
            )
            return i, new_content

        rewrite_tasks = [
            _rewrite(i, written_chapters[i], result.feedback)
            for i, result in enumerate(full_results)
            if not result.passed
        ]
        if rewrite_tasks:
            rewrite_results = await asyncio.gather(*rewrite_tasks)
            for i, new_content in rewrite_results:
                ch = written_chapters[i]
                written_chapters[i] = {"title": ch["title"], "content": new_content, "index": i, "research": ch.get("research", ""), "opinions": ch.get("opinions", "")}

            # 二次全文审：重写后再审一次
            full_results2 = await self._reviewer.review_full(
                topic=self.topic,
                chapters=written_chapters,
            )
            rewrite_tasks2 = [
                _rewrite(i, written_chapters[i], result.feedback)
                for i, result in enumerate(full_results2)
                if not result.passed
            ]
            if rewrite_tasks2:
                rewrite_results2 = await asyncio.gather(*rewrite_tasks2)
                for i, new_content in rewrite_results2:
                    ch = written_chapters[i]
                    written_chapters[i] = {"title": ch["title"], "content": new_content, "index": i, "research": ch.get("research", ""), "opinions": ch.get("opinions", "")}
                    log.warning("[%s] full_review still failed after rewrite  chapter=%r", self.job_id[:8], ch["title"])

        job.chapters = written_chapters
        job_store.update(job)

        final_results = full_results2 if rewrite_tasks else full_results
        await push_event(self.job_id, SSEEvent(
            event="review_done",
            data={
                "results": [
                    {"title": written_chapters[i]["title"], "passed": r.passed, "feedback": r.feedback}
                    for i, r in enumerate(final_results)
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
        article_id = None
        try:
            article_id = await self._save_article(job.id, self.topic, markdown)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning("Failed to save article to DB: %s", e)

        log.info("[%s] pipeline done  total_elapsed=%.2fs", self.job_id[:8], time.monotonic() - pipeline_start)
        job.stage = StageStatus.DONE
        job_store.update(job)
        done_data: dict = {"output_path": output_path}
        if article_id:
            done_data["article_id"] = article_id
        await push_event(self.job_id, SSEEvent(
            event="done", data=done_data
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
        chinese = len(re.findall(r'[\u4e00-\u9fff]', text))
        english = len(re.findall(r'[a-zA-Z]+', text))
        return chinese + english

    @staticmethod
    async def _save_article(job_id: str, topic: str, content: str) -> str:
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
            await session.refresh(article)
            return article.id
