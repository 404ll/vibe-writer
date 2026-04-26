import logging
from dataclasses import dataclass, field
from backend.agent.base import BaseAgent
from backend.agent.prompts import (
    CHAPTER_REVIEW_SYSTEM, CHAPTER_REVIEW_USER,
    FULL_REVIEW_SYSTEM, FULL_REVIEW_USER,
)

log = logging.getLogger("vibe.reviewer")


@dataclass
class ReviewResult:
    passed: bool
    feedback: str = field(default="")


class ReviewAgent(BaseAgent):
    """
    审稿 Agent，提供两种审稿模式：
    - review_chapter: 轻审，检查单章连贯性和完整度
    - review_full: 重审，检查全文整体质量
    两种模式不通过时均返回 feedback，由 Orchestrator 决定是否重写。
    """

    async def review_chapter(
        self,
        chapter_title: str,
        content: str,
        outline: str,
    ) -> ReviewResult:
        """轻审：连贯性 + 内容完整度。返回 ReviewResult。"""
        data = await self._call_llm_json(
            CHAPTER_REVIEW_SYSTEM,
            CHAPTER_REVIEW_USER.format(
                outline=outline,
                chapter_title=chapter_title,
                content=content,
            ),
            max_tokens=512,
        )
        if not data:
            log.warning("review_chapter: JSON parse failed, defaulting to PASSED  chapter=%r", chapter_title)
            return ReviewResult(passed=True, feedback="")
        return ReviewResult(
            passed=bool(data.get("passed", True)),
            feedback=data.get("feedback", ""),
        )

    async def review_full(
        self,
        topic: str,
        chapters: list[dict],
    ) -> list[ReviewResult]:
        """重审：全文整体质量。返回与 chapters 等长的 ReviewResult 列表。"""
        full_text = "\n\n".join(
            f"## {ch['title']}\n{ch['content']}" for ch in chapters
        )
        data = await self._call_llm_json(
            FULL_REVIEW_SYSTEM,
            FULL_REVIEW_USER.format(topic=topic, full_text=full_text),
            max_tokens=1024,
        )
        if not data or "results" not in data:
            log.warning("review_full: JSON parse failed, defaulting all to PASSED  topic=%r", topic)
            return [ReviewResult(passed=True, feedback="") for _ in chapters]

        results = [
            ReviewResult(
                passed=bool(r.get("passed", True)),
                feedback=r.get("feedback", ""),
            )
            for r in data["results"]
        ]
        # 数量不匹配时用 PASSED 填充（容错）
        while len(results) < len(chapters):
            results.append(ReviewResult(passed=True, feedback=""))
        return results[:len(chapters)]
